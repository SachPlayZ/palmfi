// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SecondFactorVerifier} from "./SecondFactorVerifier.sol";
import {PalmTypes as T} from "./libraries/PalmTypes.sol";
import {IAggregatorV3, IWETH9, IHub, IVault, IVaultFactory, ISafeHarborSwapper} from "./interfaces/IPalm.sol";
import {ProtectedToken} from "./tokens/ProtectedToken.sol";
import {ApprovalBook} from "./ApprovalBook.sol";

/// Shared storage, roles and helpers of a Vault. One Owner's Vault (EIP-1167 clone, immutable once initialized). Holds the Underlying, mints/burns the
/// Owner's Protected tokens and enforces every spending rule. Institutions and Individuals share this code.
abstract contract VaultBase {
    using SafeERC20 for IERC20;

    uint256 public constant BOND = 0.001 ether;

    uint256 public constant REQUEST_TTL = 7 days;

    uint256 public constant FAIL_OPEN_DELAY = 72 hours;

    uint256 public constant SHORT_TIMELOCK = 48 hours;

    uint256 public constant LONG_TIMELOCK = 7 days;

    uint256 public constant STALENESS_MARGIN = 1 hours;

    uint256 public constant SLIPPAGE_NORMAL_BPS = 200;

    uint256 public constant SLIPPAGE_VOLATILE_BPS = 500;

    uint256 internal constant USD = 1e6;

    struct Asset {
        address token; // Protected token
        address feed; // Chainlink USD feed
        uint32 heartbeat; // feed's own heartbeat
        uint8 decimals; // Underlying decimals
    }

    struct Request {
        address asset;
        address destination;
        address requester;
        uint128 amount;
        uint128 usdValue;
        uint64 createdAt;
        uint64 executableAt; // 0 = not executable through a Verdict
        uint8 state;
        bool asWeth;
        bool secondFactor;
        bool recoveryApproved;
        uint256 reasonCodes;
        bytes32 requestHash;
    }

    struct Change {
        uint8 kind;
        uint64 eta;
        bool done;
        bytes data;
    }

    error NotFactory();

    error NotHub();

    error NotHook();

    error NotRegistry();

    error NotHotWallet();

    error NotRecoveryKey();

    error NotGuardian();

    error Unauthorized();

    error DelegateNotApproved(address target);

    error NotActive();

    error Paused();

    error UnknownAsset();

    error Blocklisted(address destination);

    error OverBudget(uint256 usdValue, uint256 available);

    error Degraded(address asset);

    error FeedStale(address asset);

    error BadBond();

    error TooManyPending();

    error BadState();

    error NotExecutable();

    error BadSignature();

    error NotFactoryVault();

    error ReservesShort();

    error TimelockActive();

    error NotLoosening();

    error NotTightening();

    error BadKind();

    error SlippageExceeded(uint256 out, uint256 minOut);

    error ZeroAmount();

    error EthSendFailed();

    IVaultFactory public factory;

    IHub public hub;

    address public registry;

    address public weth;

    address public usdc;

    address public safetyFund;

    ApprovalBook public approvalBook;

    SecondFactorVerifier public verifier;
    address public module;

    bool public institution;

    address public owner;

    address public guardian;

    address public recoveryKey;

    address public recoveryVault;

    address public approver;

    bytes32 public passkeyX;

    bytes32 public passkeyY;

    address public defaultReceiver;

    uint128 public budget24h;

    uint128 public budget7d;

    uint128 public hardCap;

    uint32 public floorDelay;

    uint32 public fullDelay;

    uint8 public bizStartHourUtc;

    uint8 public bizEndHourUtc;

    uint128 public usualMaxPayout;

    bool public paused;

    mapping(address => bool) public isHotWallet;

    address[] internal _hotWallets;

    mapping(address => bool) public isDestination;

    mapping(address => bool) public isApprovedDelegate;

    address[] internal _underlyings;

    mapping(address => Asset) public assets;

    uint128 public used24h;

    uint128 public used7d;

    uint64 public lastSpendAt;

    uint256 public nextRequestId;

    uint256 public pendingCount;

    mapping(uint256 => Request) internal _requests;

    uint256[] internal _open;

    mapping(uint256 => uint256) internal _openIndex; // id => index+1

    // --- Settings changes ---
    uint256 public nextChangeId;
    uint256 public sensitivePending; // Guardian / Recovery / Approver / passkey changes pending
    mapping(uint256 => Change) internal _changes;

    uint256 public unfreezeNonce;

    // ------------------------------------------------------------------
    // Init
    // ------------------------------------------------------------------

    struct Wiring {
        address hub;
        address registry;
        address weth;
        address usdc;
        address safetyFund;
        address approvalBook;
        address verifier;
        address module;
        address[] underlyings;
        address[] tokens;
        address[] feeds;
        uint32[] heartbeats;
        address[] defaultDelegates;
    }

    modifier onlyHot() {
        _checkHot(msg.sender);
        _;
    }

    modifier onlyRecovery() {
        if (msg.sender != recoveryKey) revert NotRecoveryKey();
        _;
    }

    modifier outflowsOpen() {
        if (hub.statusOf(address(this)) != T.STATUS_ACTIVE) revert NotActive();
        if (paused) revert Paused();
        _;
    }

    /// Hot wallet + EIP-7702 signer-integrity check (brief §6.5).
    function _checkHot(address a) internal view {
        if (!isHotWallet[a]) revert NotHotWallet();
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

    receive() external payable {
        // Only WETH unwrapping sends ETH here; anything else is a donation to reserves-free balance.
    }

    /// Chainlink USD value (6dp) with a per-feed staleness bound of heartbeat + 1h. decimals() read from the feed.
    function valueUsd(address underlying, uint256 amount) public view returns (uint256 usd, bool stale) {
        Asset memory a = assets[underlying];
        if (a.token == address(0)) revert UnknownAsset();
        (, int256 answer,, uint256 updatedAt,) = IAggregatorV3(a.feed).latestRoundData();
        uint8 fd = IAggregatorV3(a.feed).decimals();
        stale = answer <= 0 || updatedAt + a.heartbeat + STALENESS_MARGIN < block.timestamp;
        if (answer > 0) usd = amount * uint256(answer) * USD / (10 ** a.decimals) / (10 ** fd);
    }

    function _degraded(address underlying) internal view returns (bool) {
        if (hub.marketMode(underlying) == T.MODE_DEGRADED) return true;
        (, bool stale) = valueUsd(underlying, 0);
        return stale;
    }

    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) {
            // Never let a griefing requester block a state transition: route the bond to the SafetyFund.
            (ok,) = safetyFund.call{value: amount}("");
            if (!ok) revert EthSendFailed();
        }
    }

    function _migrate() internal {
        uint8 s = hub.statusOf(address(this));
        if (s == T.STATUS_MIGRATED || s == T.STATUS_REVOKED) revert NotActive();
        for (uint256 i; i < _underlyings.length; i++) {
            address u = _underlyings[i];
            ProtectedToken t = ProtectedToken(assets[u].token);
            for (uint256 j; j < _hotWallets.length; j++) {
                uint256 b = t.balanceOf(_hotWallets[j]);
                if (b > 0) t.burn(_hotWallets[j], b);
            }
            uint256 bal = IERC20(u).balanceOf(address(this));
            if (bal > 0) IERC20(u).safeTransfer(recoveryVault, bal);
        }
        hub.vaultMigrated(recoveryVault);
    }

    function _addHotWallet(address h) internal {
        if (h == address(0) || isHotWallet[h]) return;
        isHotWallet[h] = true;
        _hotWallets.push(h);
    }

    function _asset(address u) internal view returns (Asset memory a) {
        a = assets[u];
        if (a.token == address(0)) revert UnknownAsset();
    }
}
