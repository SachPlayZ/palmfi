// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PalmTypes as T} from "./libraries/PalmTypes.sol";
import {IHub, IVaultFactory} from "./interfaces/IPalm.sol";
import {ProtectedToken} from "./tokens/ProtectedToken.sol";

/// Shared storage, roles and helpers of a Vault (v2: Arc, USDC-only, intra-org votes, ADR-0008/0009/0011).
/// One org's or person's Vault (EIP-1167 clone, immutable once initialized). Holds USDC 1:1 behind its Protected
/// token. Its whitelisted wallets are its Voters: one wallet, one vote.
abstract contract VaultBase {
    using SafeERC20 for IERC20;

    /// Requests expire after this, executed or not.
    uint256 public constant REQUEST_TTL = 7 days;
    /// Loosening changes wait this long after a majority passes them.
    uint256 public constant SHORT_TIMELOCK = 48 hours;
    /// Recovery changes wait this long after a majority passes them.
    uint256 public constant LONG_TIMELOCK = 7 days;
    /// Escrowed with every Queued request (burned Protected tokens, re-minted unless the request is FLAGged).
    uint256 public constant BOND = 1e6;
    /// Max open Queued requests per wallet (voter-fatigue guard).
    uint256 public constant MAX_PENDING_PER_WALLET = 3;
    /// Fewer wallets than this and one hacked wallet can block every honest Veto.
    uint256 public constant MIN_WALLETS = 3;
    /// Executed outflows kept as the onchain baseline the Sentinel scores against.
    uint256 public constant HISTORY = 32;

    struct Request {
        address destination; // outside address (UNWRAP) or payee Vault (PAYMENT)
        address requester;
        uint128 amount;
        uint64 createdAt;
        uint64 executableAt;
        uint8 state;
        uint8 kind;
        bool fastTracked;
        bool scored;
        uint16 voterCount; // snapshot at creation
        uint16 yes;
        uint16 no;
        uint32 score; // Sentinel's Deviation score, milli-bits
        uint256 reasonCodes;
        bytes32 requestHash;
    }

    struct Change {
        uint8 kind;
        bool done;
        uint16 voterCount; // snapshot at proposal
        uint16 yes;
        uint64 createdAt;
        uint64 eta; // 0 until a majority passes it
        bytes data;
    }

    error Unauthorized();
    error NotHub();
    error NotHook();
    error NotWallet();
    error NotRecoveryKey();
    error DelegateNotApproved(address target);
    error NotActive();
    error Blocklisted(address destination);
    error OverBudget(uint256 amount, uint256 available);
    error TooManyPending();
    error TooFewWallets();
    error BadState();
    error NotExecutable();
    error NotEligible();
    error AlreadyVoted();
    error NotFactoryVault();
    error ReservesShort();
    error TimelockActive();
    error NotTightening();
    error BadKind();
    error ZeroAmount();

    IVaultFactory public factory;
    IHub public hub;
    address public usdc;
    address public module;
    /// This Vault's Protected token.
    address public token;

    address public recoveryKey;
    address public recoveryVault;

    uint128 public budget24h;
    uint128 public budget7d;
    uint128 public hardCap;
    uint32 public floorDelay;
    uint32 public maxDelay;
    uint32 public capDelay;
    // Coarse profile (ADR-0007): the Sentinel's cold-start prior.
    uint8 public bizStartHourUtc;
    uint8 public bizEndHourUtc;
    uint128 public usualMaxPayout;

    mapping(address => bool) public isWallet;
    mapping(address => uint64) public walletAddedAt;
    address[] internal _wallets;
    mapping(address => bool) public isDestination;
    mapping(address => bool) public isApprovedDelegate;

    uint128 public used24h;
    uint128 public used7d;
    uint64 public lastSpendAt;

    uint256 public nextRequestId;
    mapping(address => uint256) public pendingOf;
    mapping(uint256 => Request) internal _requests;
    uint256[] internal _open;
    mapping(uint256 => uint256) internal _openIndex; // id => index+1
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    uint256 public nextChangeId;
    mapping(uint256 => Change) internal _changes;
    mapping(uint256 => mapping(address => bool)) public hasVotedChange;
    /// Wallet additions proposed or passed but not executed: any request meanwhile scores CONFIG_CHANGE_PENDING.
    uint256 public pendingWalletAdds;

    T.Outflow[32] internal _history;
    uint256 public historyCount;
    mapping(address => uint256) public destinationCount;

    struct Wiring {
        address hub;
        address usdc;
        address module;
        address token;
        address[] defaultDelegates;
    }

    modifier onlyWallet() {
        _checkWallet(msg.sender);
        _;
    }

    modifier outflowsOpen() {
        if (hub.statusOf(address(this)) != T.STATUS_ACTIVE) revert NotActive();
        _;
    }

    modifier onlyHook() {
        if (msg.sender != factory.hook()) revert NotHook();
        _;
    }

    /// Wallet + EIP-7702 signer-integrity check (brief §6.5).
    function _checkWallet(address a) internal view {
        if (!isWallet[a]) revert NotWallet();
        address target = delegationOf(a);
        if (target != address(0) && !isApprovedDelegate[target]) revert DelegateNotApproved(target);
    }

    /// EIP-7702 delegation target of `a` (0xef0100 ‖ address), or zero if `a` isn't a delegated EOA.
    function delegationOf(address a) public view returns (address target) {
        bytes memory code = a.code;
        if (code.length == 23 && code[0] == 0xef && code[1] == 0x01 && code[2] == 0x00) {
            assembly {
                target := shr(96, mload(add(code, 35)))
            }
        }
    }

    /// Majority of `n` voters: strictly more than half.
    function _majority(uint256 votes, uint256 n) internal pure returns (bool) {
        return votes * 2 > n;
    }

    // --- Instant budget (USDC is the unit: $1 = 1e6) ---

    function _spendInstant(uint256 amount) internal {
        (uint256 u24, uint256 u7) = _usage();
        uint256 avail = _available(u24, u7);
        if (amount > avail) revert OverBudget(amount, avail);
        used24h = uint128(u24 + amount);
        used7d = uint128(u7 + amount);
        lastSpendAt = uint64(block.timestamp);
    }

    function _usage() internal view returns (uint256 u24, uint256 u7) {
        uint256 elapsed = block.timestamp - lastSpendAt;
        uint256 refill24 = elapsed * budget24h / 1 days;
        uint256 refill7 = elapsed * budget7d / 7 days;
        u24 = used24h > refill24 ? used24h - refill24 : 0;
        u7 = used7d > refill7 ? used7d - refill7 : 0;
    }

    function _available(uint256 u24, uint256 u7) internal view returns (uint256) {
        uint256 a24 = budget24h > u24 ? budget24h - u24 : 0;
        uint256 a7 = budget7d > u7 ? budget7d - u7 : 0;
        return a24 < a7 ? a24 : a7;
    }

    // --- Baseline: written only for outflows that actually left (never for vetoed or flagged requests) ---

    function _record(address wallet, address destination, uint256 amount) internal {
        _history[historyCount % HISTORY] = T.Outflow(wallet, destination, uint128(amount), uint64(block.timestamp));
        historyCount++;
        destinationCount[destination]++;
    }

    function _addWallet(address w) internal {
        if (w == address(0) || isWallet[w]) return;
        isWallet[w] = true;
        walletAddedAt[w] = uint64(block.timestamp);
        _wallets.push(w);
    }

    function _removeWallet(address w) internal {
        if (!isWallet[w]) revert NotWallet();
        if (_wallets.length <= MIN_WALLETS) revert TooFewWallets();
        isWallet[w] = false;
        for (uint256 i; i < _wallets.length; i++) {
            if (_wallets[i] == w) {
                _wallets[i] = _wallets[_wallets.length - 1];
                _wallets.pop();
                break;
            }
        }
    }

    function _migrate() internal {
        uint8 s = hub.statusOf(address(this));
        if (s == T.STATUS_MIGRATED || s == T.STATUS_REVOKED) revert NotActive();
        ProtectedToken t = ProtectedToken(token);
        for (uint256 j; j < _wallets.length; j++) {
            uint256 b = t.balanceOf(_wallets[j]);
            if (b > 0) t.burn(_wallets[j], b);
        }
        uint256 bal = IERC20(usdc).balanceOf(address(this));
        if (bal > 0) IERC20(usdc).safeTransfer(recoveryVault, bal);
        hub.vaultMigrated(recoveryVault);
    }
}
