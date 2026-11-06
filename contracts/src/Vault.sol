// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {PalmTypes as T} from "./libraries/PalmTypes.sol";
import {IAggregatorV3, IWETH9, IHub, IVault, IVaultFactory, ISafeHarborSwapper} from "./interfaces/IPalm.sol";
import {ProtectedToken} from "./tokens/ProtectedToken.sol";
import {ApprovalBook} from "./ApprovalBook.sol";

/// One Owner's Vault (EIP-1167 clone, immutable once initialized). Holds the Underlying, mints/burns the
/// Owner's Protected tokens and enforces every spending rule. Institutions and Individuals share this code.
contract Vault is IVault {
    using SafeERC20 for IERC20;

    // --- protocol constants (brief §6.8) ---
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

    // --- wiring (set once by the factory) ---
    IVaultFactory public factory;
    IHub public hub;
    address public registry;
    address public weth;
    address public usdc;
    address public safetyFund;
    ApprovalBook public approvalBook;

    // --- roles & config ---
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

    // --- assets ---
    address[] internal _underlyings;
    mapping(address => Asset) public assets;

    // --- Instant budget (leaky buckets, USD 6dp) ---
    uint128 public used24h;
    uint128 public used7d;
    uint64 public lastSpendAt;

    // --- Queued requests ---
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
        address[] underlyings;
        address[] tokens;
        address[] feeds;
        uint32[] heartbeats;
        address[] defaultDelegates;
    }

    function initialize(T.VaultConfig calldata c, Wiring calldata w) external {
        if (address(factory) != address(0)) revert Unauthorized();
        factory = IVaultFactory(msg.sender);
        hub = IHub(w.hub);
        registry = w.registry;
        weth = w.weth;
        usdc = w.usdc;
        safetyFund = w.safetyFund;
        approvalBook = ApprovalBook(w.approvalBook);

        owner = c.owner;
        guardian = c.guardian;
        recoveryKey = c.recoveryKey;
        recoveryVault = c.recoveryVault;
        approver = c.approver;
        institution = c.approver != address(0);
        passkeyX = c.passkeyX;
        passkeyY = c.passkeyY;
        budget24h = c.budget24h;
        budget7d = c.budget7d;
        hardCap = c.hardCap;
        floorDelay = c.floorDelay;
        fullDelay = c.fullDelay;
        bizStartHourUtc = c.bizStartHourUtc;
        bizEndHourUtc = c.bizEndHourUtc;
        usualMaxPayout = c.usualMaxPayout;

        for (uint256 i; i < c.hotWallets.length; i++) {
            _addHotWallet(c.hotWallets[i]);
        }
        defaultReceiver = c.defaultReceiver == address(0) ? c.hotWallets[0] : c.defaultReceiver;
        if (!isHotWallet[defaultReceiver]) revert NotHotWallet();
        for (uint256 i; i < c.destinations.length; i++) {
            isDestination[c.destinations[i]] = true;
        }
        for (uint256 i; i < w.defaultDelegates.length; i++) {
            isApprovedDelegate[w.defaultDelegates[i]] = true;
        }

        for (uint256 i; i < w.underlyings.length; i++) {
            address u = w.underlyings[i];
            _underlyings.push(u);
            assets[u] = Asset(w.tokens[i], w.feeds[i], w.heartbeats[i], IERC20Metadata(u).decimals());
        }
    }

    // ------------------------------------------------------------------
    // Modifiers / guards
    // ------------------------------------------------------------------

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

    // ------------------------------------------------------------------
    // Deposits (always open, even when Frozen)
    // ------------------------------------------------------------------

    function deposit(address underlying, uint256 amount, address to) external {
        if (amount == 0) revert ZeroAmount();
        Asset memory a = _asset(underlying);
        IERC20(underlying).safeTransferFrom(msg.sender, address(this), amount);
        ProtectedToken(a.token).mint(to, amount);
    }

    function depositETH(address to) external payable {
        if (msg.value == 0) revert ZeroAmount();
        IWETH9(weth).deposit{value: msg.value}();
        ProtectedToken(assets[weth].token).mint(to, msg.value);
    }

    receive() external payable {
        // Only WETH unwrapping sends ETH here; anything else is a donation to reserves-free balance.
    }

    // ------------------------------------------------------------------
    // Instant lane
    // ------------------------------------------------------------------

    function unwrap(address underlying, uint256 amount, address destination, bool asWeth)
        external
        onlyHot
        outflowsOpen
    {
        if (amount == 0) revert ZeroAmount();
        if (hub.isBlocked(destination)) revert Blocklisted(destination);
        _spendInstant(underlying, amount);
        ProtectedToken(assets[underlying].token).burn(msg.sender, amount);
        _payout(underlying, amount, destination, asWeth);
    }

    /// Network transfer within the Instant budget (ADR-0001). Above budget, use requestUnwrap(payee vault).
    function networkTransfer(address underlying, uint256 amount, address payeeVault) external onlyHot outflowsOpen {
        if (amount == 0) revert ZeroAmount();
        if (!factory.isVault(payeeVault) || payeeVault == address(this)) revert NotFactoryVault();
        _spendInstant(underlying, amount);
        ProtectedToken(assets[underlying].token).burn(msg.sender, amount);
        _payout(underlying, amount, payeeVault, true);
    }

    function _spendInstant(address underlying, uint256 amount) internal returns (uint256 usd) {
        _asset(underlying);
        if (_degraded(underlying)) revert Degraded(underlying);
        bool stale;
        (usd, stale) = valueUsd(underlying, amount);
        if (stale) revert FeedStale(underlying);
        (uint256 u24, uint256 u7) = _usage();
        uint256 avail = _available(u24, u7);
        if (usd > avail) revert OverBudget(usd, avail);
        used24h = uint128(u24 + usd);
        used7d = uint128(u7 + usd);
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
        if (sensitivePending > 0) return 0;
        uint256 a24 = budget24h > u24 ? budget24h - u24 : 0;
        uint256 a7 = budget7d > u7 ? budget7d - u7 : 0;
        return a24 < a7 ? a24 : a7;
    }

    /// Remaining shared USD Instant budget (6dp) right now.
    function availableBudgetUsd() public view returns (uint256) {
        (uint256 u24, uint256 u7) = _usage();
        return _available(u24, u7);
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

    /// Effective Market mode: the Reconciler's mode, forced to Degraded when the feed is stale.
    function marketModeOf(address underlying) external view returns (uint8) {
        return _degraded(underlying) ? T.MODE_DEGRADED : hub.marketMode(underlying);
    }

    function _payout(address underlying, uint256 amount, address destination, bool asWeth) internal {
        if (factory.isVault(destination)) {
            IERC20(underlying).safeTransfer(destination, amount);
            IVault(destination).receiveNetworkTransfer(underlying, amount);
            hub.emitNetworkTransfer(destination, underlying, amount);
        } else if (underlying == weth && !asWeth) {
            IWETH9(weth).withdraw(amount);
            (bool ok,) = destination.call{value: amount}("");
            if (!ok) revert EthSendFailed();
        } else {
            IERC20(underlying).safeTransfer(destination, amount);
        }
    }

    // ------------------------------------------------------------------
    // Network transfers (payee side)
    // ------------------------------------------------------------------

    /// Accepted even while Frozen; only from factory Vaults, and only if the Underlying actually arrived.
    function receiveNetworkTransfer(address underlying, uint256 amount) external {
        if (!factory.isVault(msg.sender)) revert NotFactoryVault();
        uint8 s = hub.statusOf(address(this));
        if (s != T.STATUS_ACTIVE && s != T.STATUS_FROZEN) revert NotActive();
        Asset memory a = _asset(underlying);
        if (IERC20(underlying).balanceOf(address(this)) < ProtectedToken(a.token).totalSupply() + amount) {
            revert ReservesShort();
        }
        ProtectedToken(a.token).mint(defaultReceiver, amount);
    }

    // ------------------------------------------------------------------
    // Queued lane
    // ------------------------------------------------------------------

    function requestUnwrap(address underlying, uint256 amount, address destination, bool asWeth)
        external
        payable
        onlyHot
        outflowsOpen
        returns (uint256 id)
    {
        if (amount == 0) revert ZeroAmount();
        if (msg.value != BOND) revert BadBond();
        if (pendingCount >= (institution ? 10 : 3)) revert TooManyPending();
        _asset(underlying);

        (uint256 usd, bool stale) = valueUsd(underlying, amount);
        uint256 codes;
        if (!isDestination[destination]) codes |= T.NEW_DESTINATION;
        if (hub.isBlocked(destination)) codes |= T.BLOCKLISTED_DEST;
        if (sensitivePending > 0) codes |= T.CONFIG_CHANGE_PENDING;
        if (stale || _degraded(underlying)) codes |= T.ORACLE_STALE;
        if (usd > availableBudgetUsd()) codes |= T.OVER_BUDGET;

        ProtectedToken(assets[underlying].token).burn(msg.sender, amount); // escrow by burning
        id = ++nextRequestId;
        bytes32 h = T.hashRequest(address(this), id, underlying, amount, destination);
        _requests[id] = Request({
            asset: underlying,
            destination: destination,
            requester: msg.sender,
            amount: uint128(amount),
            usdValue: uint128(usd),
            createdAt: uint64(block.timestamp),
            executableAt: 0,
            state: T.REQ_PENDING,
            asWeth: asWeth,
            secondFactor: false,
            recoveryApproved: false,
            reasonCodes: codes,
            requestHash: h
        });
        pendingCount++;
        _open.push(id);
        _openIndex[id] = _open.length;
        hub.emitUnwrapRequested(id, h, underlying, amount, destination, usd, codes);
    }

    /// Records a Second factor for a request: an Individual's passkey (WebAuthn over the request hash)
    /// or an Institution's Payout approval (EIP-712, ADR-0002). Anyone may submit; the signature is the auth.
    function confirm(uint256 id, bytes calldata sig) external {
        Request storage r = _requests[id];
        if (r.state != T.REQ_PENDING && r.state != T.REQ_HELD && r.state != T.REQ_CLEARED) revert BadState();
        if (institution) {
            (uint64 expiry, bytes memory ecdsaSig) = abi.decode(sig, (uint64, bytes));
            if (expiry < block.timestamp) revert BadSignature();
            bytes32 digest =
                approvalBook.payoutDigest(address(this), r.requestHash, r.amount, r.asset, r.destination, expiry);
            (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, ecdsaSig);
            if (err != ECDSA.RecoverError.NoError || signer != approver) revert BadSignature();
        } else {
            WebAuthn.WebAuthnAuth memory auth = abi.decode(sig, (WebAuthn.WebAuthnAuth));
            if (!WebAuthn.verify(abi.encodePacked(r.requestHash), auth, passkeyX, passkeyY)) revert BadSignature();
        }
        r.secondFactor = true;
        if (r.state == T.REQ_HELD) {
            r.executableAt = uint64(r.createdAt + fullDelay);
        } else if (r.state == T.REQ_CLEARED && r.usdValue > hardCap) {
            r.executableAt = uint64(r.createdAt + floorDelay);
        }
        hub.emitSecondFactorConfirmed(id, r.requestHash);
        hub.emitRequestUpdated(id, r.state, r.executableAt, r.reasonCodes);
    }

    /// Institution fail-closed path: with CRE silent, a request executes only with the Approver's Payout
    /// approval (confirm) and the Recovery key's approval.
    function recoveryApprove(uint256 id) external onlyRecovery {
        Request storage r = _requests[id];
        if (r.state != T.REQ_PENDING) revert BadState();
        r.recoveryApproved = true;
    }

    function cancel(uint256 id) external {
        Request storage r = _requests[id];
        if (!isHotWallet[msg.sender] && msg.sender != guardian && msg.sender != recoveryKey) revert Unauthorized();
        if (isHotWallet[msg.sender]) _checkHot(msg.sender);
        if (!_isOpen(r.state)) revert BadState();
        _close(id, r, T.REQ_CANCELLED, true);
    }

    function expire(uint256 id) external {
        Request storage r = _requests[id];
        if (!_isOpen(r.state) || block.timestamp <= r.createdAt + REQUEST_TTL) revert BadState();
        _close(id, r, T.REQ_EXPIRED, true);
    }

    /// Anyone can execute once a request is executable.
    function execute(uint256 id) external outflowsOpen {
        Request storage r = _requests[id];
        if (!isExecutable(id)) revert NotExecutable();
        if (hub.isBlocked(r.destination)) revert Blocklisted(r.destination);
        address requester = r.requester;
        r.state = T.REQ_EXECUTED;
        _removeOpen(id);
        pendingCount--;
        hub.emitRequestUpdated(id, T.REQ_EXECUTED, r.executableAt, r.reasonCodes);
        _payout(r.asset, r.amount, r.destination, r.asWeth);
        _sendEth(requester, BOND);
    }

    function isExecutable(uint256 id) public view returns (bool) {
        Request storage r = _requests[id];
        if (block.timestamp > r.createdAt + REQUEST_TTL) return false;
        if (r.state == T.REQ_CLEARED || r.state == T.REQ_HELD) {
            return r.executableAt != 0 && block.timestamp >= r.executableAt;
        }
        if (r.state == T.REQ_PENDING) {
            if (institution) {
                return r.secondFactor && r.recoveryApproved && block.timestamp >= r.createdAt + floorDelay;
            }
            return block.timestamp >= r.createdAt + FAIL_OPEN_DELAY;
        }
        return false;
    }

    /// Applies a Sentinel Verdict (spec §6.3 table). Never reverts on content: returns a reject reason instead.
    function applyVerdict(uint256 id, bytes32 requestHash, uint8 verdict, uint256 reasonCodes)
        external
        returns (uint8 reject, address destination)
    {
        if (msg.sender != address(hub)) revert NotHub();
        Request storage r = _requests[id];
        if (r.state == T.REQ_NONE) return (T.REJECT_UNKNOWN_REQUEST, address(0));
        if (r.requestHash != requestHash) return (T.REJECT_HASH_MISMATCH, address(0));
        destination = r.destination;
        if (!_isOpen(r.state)) return (T.REJECT_TERMINAL, destination);
        r.reasonCodes = reasonCodes;

        if (verdict == T.VERDICT_FLAG) {
            r.state = T.REQ_FLAGGED;
            r.executableAt = 0;
            _removeOpen(id);
            pendingCount--;
            ProtectedToken(assets[r.asset].token).mint(_returnTo(r.requester), r.amount); // funds stay in the Vault
            _sendEth(safetyFund, BOND); // forfeited bond
        } else if (verdict == T.VERDICT_CLEAR) {
            r.state = T.REQ_CLEARED;
            bool needs2fa = r.usdValue > hardCap;
            r.executableAt = uint64(r.createdAt + ((needs2fa && !r.secondFactor) ? fullDelay : floorDelay));
        } else if (verdict == T.VERDICT_HOLD) {
            if (r.state == T.REQ_CLEARED) return (T.REJECT_TERMINAL, destination); // CLEAR→HOLD not allowed
            r.state = T.REQ_HELD;
            r.executableAt = r.secondFactor ? uint64(r.createdAt + fullDelay) : 0;
        } else {
            return (T.REJECT_BAD_VERDICT, destination);
        }
        hub.emitRequestUpdated(id, r.state, r.executableAt, reasonCodes);
    }

    function _isOpen(uint8 s) internal pure returns (bool) {
        return s == T.REQ_PENDING || s == T.REQ_CLEARED || s == T.REQ_HELD;
    }

    function _close(uint256 id, Request storage r, uint8 state, bool refund) internal {
        r.state = state;
        r.executableAt = 0;
        _removeOpen(id);
        pendingCount--;
        ProtectedToken(assets[r.asset].token).mint(_returnTo(r.requester), r.amount);
        if (refund) _sendEth(r.requester, BOND);
        hub.emitRequestUpdated(id, state, 0, r.reasonCodes);
    }

    function _returnTo(address requester) internal view returns (address) {
        return isHotWallet[requester] ? requester : defaultReceiver;
    }

    function _removeOpen(uint256 id) internal {
        uint256 idx = _openIndex[id];
        if (idx == 0) return;
        uint256 last = _open[_open.length - 1];
        _open[idx - 1] = last;
        _openIndex[last] = idx;
        _open.pop();
        delete _openIndex[id];
    }

    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) {
            // Never let a griefing requester block a state transition: route the bond to the SafetyFund.
            (ok,) = safetyFund.call{value: amount}("");
            if (!ok) revert EthSendFailed();
        }
    }

    // ------------------------------------------------------------------
    // Freeze, Guardian, Recovery
    // ------------------------------------------------------------------

    function pause() external {
        if (msg.sender != guardian && msg.sender != recoveryKey) _checkHot(msg.sender);
        paused = true;
        hub.vaultPaused(true);
    }

    function unpause() external onlyRecovery {
        paused = false;
        hub.vaultPaused(false);
    }

    /// Recovery key ends a Freeze. Individuals also need their passkey over the unfreeze challenge.
    function unfreeze(bytes calldata passkeySig) external onlyRecovery {
        if (!institution) {
            WebAuthn.WebAuthnAuth memory auth = abi.decode(passkeySig, (WebAuthn.WebAuthnAuth));
            if (!WebAuthn.verify(abi.encodePacked(unfreezeChallenge()), auth, passkeyX, passkeyY)) {
                revert BadSignature();
            }
        }
        unfreezeNonce++;
        hub.vaultUnfreeze();
    }

    function unfreezeChallenge() public view returns (bytes32) {
        return keccak256(abi.encode("palmfi.unfreeze", block.chainid, address(this), unfreezeNonce));
    }

    function migrate() external onlyRecovery {
        _migrate();
    }

    /// Guardian evacuation: everything to the Owner's own Recovery vault, nothing else.
    function evacuate() external {
        if (msg.sender != guardian) revert NotGuardian();
        _migrate();
    }

    function voteMigrate() external {
        if (msg.sender != registry) revert NotRegistry();
        _migrate();
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

    // ------------------------------------------------------------------
    // Settings: tightening instant, loosening timelocked (Recovery key only)
    // ------------------------------------------------------------------

    function _checkTightener() internal view {
        if (msg.sender != recoveryKey) _checkHot(msg.sender);
    }

    function lowerBudget(uint128 b24, uint128 b7) external {
        _checkTightener();
        if (b24 > budget24h || b7 > budget7d) revert NotTightening();
        budget24h = b24;
        budget7d = b7;
    }

    function tightenLimits(uint128 cap, uint32 floor_, uint32 full) external {
        _checkTightener();
        if (cap > hardCap || floor_ < floorDelay || full < fullDelay) revert NotTightening();
        hardCap = cap;
        floorDelay = floor_;
        fullDelay = full;
    }

    function removeDestination(address d) external {
        _checkTightener();
        isDestination[d] = false;
    }

    function removeHotWallet(address h) external {
        _checkTightener();
        if (h == defaultReceiver || !isHotWallet[h]) revert BadKind();
        isHotWallet[h] = false;
        for (uint256 i; i < _hotWallets.length; i++) {
            if (_hotWallets[i] == h) {
                _hotWallets[i] = _hotWallets[_hotWallets.length - 1];
                _hotWallets.pop();
                break;
            }
        }
    }

    function removeDelegate(address d) external {
        _checkTightener();
        isApprovedDelegate[d] = false;
    }

    function setDefaultReceiver(address h) external {
        _checkTightener();
        if (!isHotWallet[h]) revert NotHotWallet();
        defaultReceiver = h;
    }

    function proposeChange(uint8 kind, bytes calldata data) external onlyRecovery returns (uint256 id) {
        uint256 lock;
        if (kind == T.CHANGE_BUDGET) {
            (uint128 b24, uint128 b7) = abi.decode(data, (uint128, uint128));
            if (b24 <= budget24h && b7 <= budget7d) revert NotLoosening();
            lock = SHORT_TIMELOCK;
        } else if (kind == T.CHANGE_LIMITS) {
            abi.decode(data, (uint128, uint32, uint32));
            lock = SHORT_TIMELOCK;
        } else if (kind >= T.CHANGE_ADD_DESTINATION && kind <= T.CHANGE_ADD_DELEGATE) {
            abi.decode(data, (address));
            lock = SHORT_TIMELOCK;
        } else if (kind >= T.CHANGE_GUARDIAN && kind <= T.CHANGE_PASSKEY) {
            lock = LONG_TIMELOCK;
            sensitivePending++;
        } else {
            revert BadKind();
        }
        id = ++nextChangeId;
        uint64 eta = uint64(block.timestamp + lock);
        _changes[id] = Change(kind, eta, false, data);
        hub.emitConfigChangeRequested(id, kind, data, eta);
    }

    function cancelChange(uint256 id) external {
        if (msg.sender != recoveryKey && msg.sender != guardian) revert Unauthorized();
        Change storage c = _changes[id];
        if (c.done || c.eta == 0) revert BadState();
        c.done = true;
        if (c.kind >= T.CHANGE_GUARDIAN) sensitivePending--;
    }

    function executeChange(uint256 id) external onlyRecovery {
        Change storage c = _changes[id];
        if (c.done || c.eta == 0) revert BadState();
        if (block.timestamp < c.eta) revert TimelockActive();
        c.done = true;
        uint8 k = c.kind;
        bytes memory d = c.data;
        if (k == T.CHANGE_BUDGET) {
            (budget24h, budget7d) = abi.decode(d, (uint128, uint128));
        } else if (k == T.CHANGE_LIMITS) {
            (hardCap, floorDelay, fullDelay) = abi.decode(d, (uint128, uint32, uint32));
        } else if (k == T.CHANGE_ADD_DESTINATION) {
            isDestination[abi.decode(d, (address))] = true;
        } else if (k == T.CHANGE_ADD_HOT_WALLET) {
            _addHotWallet(abi.decode(d, (address)));
        } else if (k == T.CHANGE_ADD_DELEGATE) {
            isApprovedDelegate[abi.decode(d, (address))] = true;
        } else {
            sensitivePending--;
            if (k == T.CHANGE_GUARDIAN) guardian = abi.decode(d, (address));
            else if (k == T.CHANGE_RECOVERY_KEY) recoveryKey = abi.decode(d, (address));
            else if (k == T.CHANGE_RECOVERY_VAULT) recoveryVault = abi.decode(d, (address));
            else if (k == T.CHANGE_APPROVER) approver = abi.decode(d, (address));
            else (passkeyX, passkeyY) = abi.decode(d, (bytes32, bytes32));
        }
    }

    function _addHotWallet(address h) internal {
        if (h == address(0) || isHotWallet[h]) return;
        isHotWallet[h] = true;
        _hotWallets.push(h);
    }

    // ------------------------------------------------------------------
    // Uniswap: VaultHook entry points (single policy engine) and Safe-harbor swaps
    // ------------------------------------------------------------------

    modifier onlyHook() {
        if (msg.sender != factory.hook()) revert NotHook();
        _;
    }

    /// The hook has already delivered `amount` Underlying to this Vault; mint the Protected token into the
    /// PoolManager. It can only leave the PoolManager to one of this Owner's Hot wallets (ADR-0006).
    function hookWrap(address underlying, uint256 amount) external onlyHook {
        Asset memory a = _asset(underlying);
        if (IERC20(underlying).balanceOf(address(this)) < ProtectedToken(a.token).totalSupply() + amount) {
            revert ReservesShort();
        }
        ProtectedToken(a.token).mint(ProtectedToken(a.token).poolManager(), amount);
        hub.emitHookSwap(address(0), underlying, amount, false, 0);
    }

    /// The hook has moved `amount` Protected tokens from the PoolManager to this Vault. Charge the real
    /// swapper's Instant budget, burn, and send the Underlying to the PoolManager for settlement.
    function hookUnwrap(address underlying, uint256 amount, address swapper) external onlyHook outflowsOpen {
        _checkHot(swapper);
        uint256 usd = _spendInstant(underlying, amount);
        ProtectedToken t = ProtectedToken(assets[underlying].token);
        t.burn(address(this), amount);
        IERC20(underlying).safeTransfer(t.poolManager(), amount);
        hub.emitHookSwap(swapper, underlying, amount, true, usd);
    }

    /// ETH → USDC inside the Vault through the factory's Safe-harbor swapper; no Instant budget used.
    /// Output must be ≥ Chainlink value × (1 − cap): 2% Normal, 5% Volatile; paused in Degraded mode.
    function safeHarborSwap(uint256 amountIn, bytes calldata route)
        external
        onlyHot
        outflowsOpen
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        if (_degraded(weth) || _degraded(usdc)) revert Degraded(weth);
        uint256 minOut = safeHarborMinOut(amountIn);
        ProtectedToken(assets[weth].token).burn(msg.sender, amountIn);
        address swapper = factory.safeHarborSwapper();
        uint256 before = IERC20(usdc).balanceOf(address(this));
        IERC20(weth).safeTransfer(swapper, amountIn);
        ISafeHarborSwapper(swapper).swap(amountIn, minOut, route);
        amountOut = IERC20(usdc).balanceOf(address(this)) - before;
        if (amountOut < minOut) revert SlippageExceeded(amountOut, minOut);
        ProtectedToken(assets[usdc].token).mint(msg.sender, amountOut);
        hub.emitSafeHarborSwap(msg.sender, amountIn, amountOut, minOut);
    }

    function safeHarborMinOut(uint256 amountIn) public view returns (uint256) {
        (uint256 ethUsd,) = valueUsd(weth, amountIn);
        (uint256 oneUsdc,) = valueUsd(usdc, 10 ** assets[usdc].decimals);
        uint256 fair = ethUsd * (10 ** assets[usdc].decimals) / oneUsdc;
        uint256 cap = hub.marketMode(weth) == T.MODE_VOLATILE ? SLIPPAGE_VOLATILE_BPS : SLIPPAGE_NORMAL_BPS;
        return fair * (10_000 - cap) / 10_000;
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function _asset(address u) internal view returns (Asset memory a) {
        a = assets[u];
        if (a.token == address(0)) revert UnknownAsset();
    }

    function protectedToken(address underlying) external view returns (address) {
        return assets[underlying].token;
    }

    function underlyings() external view returns (address[] memory) {
        return _underlyings;
    }

    function hotWallets() external view returns (address[] memory) {
        return _hotWallets;
    }

    function getRequest(uint256 id) external view returns (Request memory) {
        return _requests[id];
    }

    function getChange(uint256 id) external view returns (Change memory) {
        return _changes[id];
    }

    function openRequestIds() external view returns (uint256[] memory) {
        return _open;
    }

    /// Reserves vs supply per Underlying, for the Reconciler.
    function reserves() external view returns (address[] memory u, uint256[] memory held, uint256[] memory supply) {
        u = _underlyings;
        held = new uint256[](u.length);
        supply = new uint256[](u.length);
        for (uint256 i; i < u.length; i++) {
            held[i] = IERC20(u[i]).balanceOf(address(this));
            supply[i] = ProtectedToken(assets[u[i]].token).totalSupply();
        }
    }

    /// Hot wallets with their current EIP-7702 delegation target, for the Reconciler.
    function delegations()
        external
        view
        returns (address[] memory wallets, address[] memory targets, bool[] memory ok)
    {
        wallets = _hotWallets;
        targets = new address[](wallets.length);
        ok = new bool[](wallets.length);
        for (uint256 i; i < wallets.length; i++) {
            targets[i] = delegationOf(wallets[i]);
            ok[i] = targets[i] == address(0) || isApprovedDelegate[targets[i]];
        }
    }
}
