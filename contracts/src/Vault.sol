// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PalmTypes as T} from "./libraries/PalmTypes.sol";
import {IHub, IVault, IVaultFactory} from "./interfaces/IPalm.sol";
import {ProtectedToken} from "./tokens/ProtectedToken.sol";
import {VaultBase} from "./VaultBase.sol";

/// One org's or person's Vault (v2). Instant lane within budget; everything above waits for a delay the Sentinel
/// sets from its Deviation score (ADR-0009), during which the Vault's own wallets can Veto or Fast-track it
/// (ADR-0008). USDC only, through its ERC-20 interface (ADR-0011): native value is never accepted.
contract Vault is VaultBase {
    using SafeERC20 for IERC20;

    function initialize(T.VaultConfig calldata c, Wiring calldata w) external {
        if (address(factory) != address(0)) revert Unauthorized();
        if (c.wallets.length < MIN_WALLETS) revert TooFewWallets();
        factory = IVaultFactory(msg.sender);
        hub = IHub(w.hub);
        usdc = w.usdc;
        module = w.module;
        token = w.token;

        recoveryKey = c.recoveryKey;
        recoveryVault = c.recoveryVault;
        budget24h = c.budget24h;
        budget7d = c.budget7d;
        hardCap = c.hardCap;
        floorDelay = c.floorDelay;
        maxDelay = c.maxDelay;
        capDelay = c.capDelay;
        bizStartHourUtc = c.bizStartHourUtc;
        bizEndHourUtc = c.bizEndHourUtc;
        usualMaxPayout = c.usualMaxPayout;

        for (uint256 i; i < c.wallets.length; i++) {
            _addWallet(c.wallets[i]);
        }
        if (_wallets.length < MIN_WALLETS) revert TooFewWallets(); // duplicates
        for (uint256 i; i < c.destinations.length; i++) {
            isDestination[c.destinations[i]] = true;
        }
        for (uint256 i; i < w.defaultDelegates.length; i++) {
            isApprovedDelegate[w.defaultDelegates[i]] = true;
        }
    }

    // ------------------------------------------------------------------
    // Deposits
    // ------------------------------------------------------------------

    /// USDC in (ERC-20 only), Protected tokens out to one of this Vault's wallets.
    function deposit(uint256 amount, address to) external {
        if (amount == 0) revert ZeroAmount();
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), amount);
        ProtectedToken(token).mint(to, amount);
    }

    // ------------------------------------------------------------------
    // Instant lane
    // ------------------------------------------------------------------

    function unwrap(uint256 amount, address destination) external onlyWallet outflowsOpen {
        if (amount == 0) revert ZeroAmount();
        if (hub.isBlocked(destination)) revert Blocklisted(destination);
        _spendInstant(amount);
        ProtectedToken(token).burn(msg.sender, amount);
        _record(msg.sender, destination, amount);
        hub.emitOutflow(msg.sender, destination, amount, false);
        IERC20(usdc).safeTransfer(destination, amount);
    }

    /// Direct vault-to-vault payment within the Instant budget (the Orbital pool is the composable route).
    function pay(address payeeVault, uint256 amount) external onlyWallet outflowsOpen {
        if (amount == 0) revert ZeroAmount();
        _spendInstant(amount);
        ProtectedToken(token).burn(msg.sender, amount);
        _record(msg.sender, payeeVault, amount);
        hub.emitOutflow(msg.sender, payeeVault, amount, false);
        _payVault(payeeVault, amount);
    }

    /// Remaining Instant budget (USDC, 6dp) right now.
    function availableBudget() public view returns (uint256) {
        (uint256 u24, uint256 u7) = _usage();
        return _available(u24, u7);
    }

    function _payVault(address payeeVault, uint256 amount) internal {
        if (!factory.isVault(payeeVault) || payeeVault == address(this)) revert NotFactoryVault();
        IERC20(usdc).safeTransfer(payeeVault, amount);
        IVault(payeeVault).receivePayment(amount);
    }

    /// Payee side. Accepted even while Frozen; only from factory Vaults, and only if the USDC actually arrived.
    function receivePayment(uint256 amount) external {
        if (!factory.isVault(msg.sender)) revert NotFactoryVault();
        uint8 s = hub.statusOf(address(this));
        if (s != T.STATUS_ACTIVE && s != T.STATUS_FROZEN) revert NotActive();
        _mintBacked(_wallets[0], amount);
    }

    function _mintBacked(address to, uint256 amount) internal {
        if (IERC20(usdc).balanceOf(address(this)) < ProtectedToken(token).totalSupply() + amount) {
            revert ReservesShort();
        }
        ProtectedToken(token).mint(to, amount);
    }

    // ------------------------------------------------------------------
    // Queued lane
    // ------------------------------------------------------------------

    function requestUnwrap(uint256 amount, address destination) external returns (uint256) {
        return _queue(T.KIND_UNWRAP, amount, destination);
    }

    function requestPayment(address payeeVault, uint256 amount) external returns (uint256) {
        if (!factory.isVault(payeeVault) || payeeVault == address(this)) revert NotFactoryVault();
        return _queue(T.KIND_PAYMENT, amount, payeeVault);
    }

    /// Default delay is MaxDelay: until the Sentinel scores it, the slowest path applies (unsure → slow).
    function _queue(uint8 kind, uint256 amount, address destination)
        internal
        onlyWallet
        outflowsOpen
        returns (uint256 id)
    {
        if (amount == 0) revert ZeroAmount();
        if (pendingOf[msg.sender] >= MAX_PENDING_PER_WALLET) revert TooManyPending();

        uint256 codes = T.CRE_SILENT;
        if (!isDestination[destination] && destinationCount[destination] == 0) codes |= T.NEW_DESTINATION;
        if (hub.isBlocked(destination)) codes |= T.BLOCKLISTED_DEST;
        if (pendingWalletAdds > 0) codes |= T.CONFIG_CHANGE_PENDING;
        if (block.timestamp < walletAddedAt[msg.sender] + 7 days) codes |= T.NEW_WALLET;
        if (amount > hardCap) codes |= T.OVER_HARD_CAP;

        ProtectedToken(token).burn(msg.sender, amount + BOND); // escrow by burning
        id = ++nextRequestId;
        bytes32 h = T.hashRequest(address(this), id, kind, amount, destination);
        Request storage r = _requests[id];
        r.destination = destination;
        r.requester = msg.sender;
        r.amount = uint128(amount);
        r.createdAt = uint64(block.timestamp);
        r.executableAt = uint64(block.timestamp + maxDelay);
        r.state = T.REQ_PENDING;
        r.kind = kind;
        r.voterCount = uint16(_wallets.length);
        r.reasonCodes = codes;
        r.requestHash = h;
        pendingOf[msg.sender]++;
        _open.push(id);
        _openIndex[id] = _open.length;
        hub.emitRequestQueued(id, h, kind, msg.sender, amount, destination, codes);
    }

    /// One wallet, one vote, on the voter set at creation. Veto: >50% NO of the wallets other than the
    /// requester. Fast-track: >50% YES of all wallets → executable at the Floor.
    function vote(uint256 id, bool yes) external {
        Request storage r = _requests[id];
        if (r.state != T.REQ_PENDING) revert BadState();
        _checkWallet(msg.sender);
        if (walletAddedAt[msg.sender] > r.createdAt) revert NotEligible();
        if (hasVoted[id][msg.sender]) revert AlreadyVoted();
        if (!yes && msg.sender == r.requester) revert NotEligible(); // the requester cancels instead
        hasVoted[id][msg.sender] = true;
        if (yes) r.yes++;
        else r.no++;
        hub.emitVoted(id, msg.sender, yes, r.yes, r.no);

        if (_majority(r.no, r.voterCount - 1)) {
            _close(id, r, T.REQ_VETOED, true);
        } else if (!r.fastTracked && _majority(r.yes, r.voterCount)) {
            r.fastTracked = true;
            r.executableAt = uint64(r.createdAt + floorDelay);
            hub.emitRequestUpdated(id, r.state, r.executableAt, r.score, r.reasonCodes);
        }
    }

    function cancel(uint256 id) external {
        Request storage r = _requests[id];
        if (msg.sender != r.requester) revert Unauthorized();
        if (r.state != T.REQ_PENDING) revert BadState();
        _close(id, r, T.REQ_CANCELLED, true);
    }

    function expire(uint256 id) external {
        Request storage r = _requests[id];
        if (r.state != T.REQ_PENDING || block.timestamp <= r.createdAt + REQUEST_TTL) revert BadState();
        _close(id, r, T.REQ_EXPIRED, true);
    }

    /// Anyone can execute once a request is executable.
    function execute(uint256 id) external outflowsOpen {
        Request storage r = _requests[id];
        if (!isExecutable(id)) revert NotExecutable();
        if (hub.isBlocked(r.destination)) revert Blocklisted(r.destination);
        r.state = T.REQ_EXECUTED;
        _removeOpen(id);
        pendingOf[r.requester]--;
        _record(r.requester, r.destination, r.amount);
        hub.emitRequestUpdated(id, T.REQ_EXECUTED, r.executableAt, r.score, r.reasonCodes);
        hub.emitOutflow(r.requester, r.destination, r.amount, false);
        ProtectedToken(token).mint(_returnTo(r.requester), BOND);
        if (r.kind == T.KIND_PAYMENT) _payVault(r.destination, r.amount);
        else IERC20(usdc).safeTransfer(r.destination, r.amount);
    }

    function isExecutable(uint256 id) public view returns (bool) {
        Request storage r = _requests[id];
        return
            r.state == T.REQ_PENDING && block.timestamp >= r.executableAt
                && block.timestamp <= r.createdAt + REQUEST_TTL;
    }

    /// Sentinel delay (Hub-only). Clamped to [Floor, MaxDelay]; above the Hard cap at least CapDelay.
    /// A majority Fast-track beats the Sentinel.
    function applyDelay(uint256 id, bytes32 requestHash, uint64 delay, uint32 score, uint256 reasonCodes)
        external
        returns (uint8)
    {
        if (msg.sender != address(hub)) revert NotHub();
        Request storage r = _requests[id];
        if (r.state == T.REQ_NONE) return T.REJECT_UNKNOWN_REQUEST;
        if (r.requestHash != requestHash) return T.REJECT_HASH_MISMATCH;
        if (r.state != T.REQ_PENDING) return T.REJECT_TERMINAL;
        if (r.fastTracked) return T.REJECT_FAST_TRACKED;
        if (delay < floorDelay) delay = floorDelay;
        if (delay > maxDelay) delay = maxDelay;
        if (r.amount > hardCap && delay < capDelay) delay = capDelay;
        r.scored = true;
        r.score = score;
        r.reasonCodes = reasonCodes;
        r.executableAt = uint64(r.createdAt + delay);
        hub.emitRequestUpdated(id, r.state, r.executableAt, score, reasonCodes);
        return 0;
    }

    /// Sentinel FLAG (Hub-only): the request dies and its bond is forfeited; the Hub freezes the Vault.
    function applyFlag(uint256 id, bytes32 requestHash, uint32 score, uint256 reasonCodes)
        external
        returns (uint8, address)
    {
        if (msg.sender != address(hub)) revert NotHub();
        Request storage r = _requests[id];
        if (r.state == T.REQ_NONE) return (T.REJECT_UNKNOWN_REQUEST, address(0));
        if (r.requestHash != requestHash) return (T.REJECT_HASH_MISMATCH, address(0));
        if (r.state != T.REQ_PENDING) return (T.REJECT_TERMINAL, r.destination);
        r.score = score;
        r.reasonCodes = reasonCodes;
        _close(id, r, T.REQ_FLAGGED, false);
        return (0, r.destination);
    }

    function _close(uint256 id, Request storage r, uint8 state, bool refundBond) internal {
        r.state = state;
        r.executableAt = 0;
        _removeOpen(id);
        pendingOf[r.requester]--;
        // Funds never left the Vault: re-mint the escrow (the bond only when it isn't forfeited).
        ProtectedToken(token).mint(_returnTo(r.requester), refundBond ? r.amount + BOND : r.amount);
        hub.emitRequestUpdated(id, state, 0, r.score, r.reasonCodes);
    }

    function _returnTo(address requester) internal view returns (address) {
        return isWallet[requester] ? requester : _wallets[0];
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

    // ------------------------------------------------------------------
    // Freeze (any one wallet; unfreeze needs a majority or the Recovery key, in the VaultModule)
    // ------------------------------------------------------------------

    function freeze() external onlyWallet {
        hub.vaultFreeze(msg.sender);
    }

    function isFrozen() public view returns (bool) {
        return hub.statusOf(address(this)) != T.STATUS_ACTIVE;
    }

    // ------------------------------------------------------------------
    // Orbital pool seam (#33; IOrbitalVault)
    // ------------------------------------------------------------------

    /// A wallet's swap into the pool is an outflow: it uses the same Instant budget as an Unwrap, so an
    /// attacker can't exit through a token of an org they onboarded themselves.
    function chargeOutflow(address wallet, uint256 amount) external onlyHook outflowsOpen {
        _checkWallet(wallet);
        _spendInstant(amount);
        _record(wallet, msg.sender, amount);
        hub.emitOutflow(wallet, msg.sender, amount, true);
    }

    /// Settlement, issuer side: burn `amount` of this Vault's tokens held by the PoolManager and send their
    /// USDC backing to `toVault`. Halts while Frozen (a frozen token is a depeg, ADR-0010).
    function settleOut(uint256 amount, address toVault) external onlyHook outflowsOpen {
        if (!factory.isVault(toVault) || toVault == address(this)) revert NotFactoryVault();
        ProtectedToken t = ProtectedToken(token);
        t.burn(t.poolManager(), amount);
        IERC20(usdc).safeTransfer(toVault, amount);
    }

    /// Settlement, receiving side: USDC already arrived from the issuer; mint the same amount into the pool.
    function settleIn(uint256 amount) external onlyHook {
        if (IERC20(usdc).balanceOf(address(this)) < ProtectedToken(token).totalSupply() + amount) {
            revert ReservesShort();
        }
        ProtectedToken(token).mint(ProtectedToken(token).poolManager(), amount);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function wallets() external view returns (address[] memory) {
        return _wallets;
    }

    function walletCount() external view returns (uint256) {
        return _wallets.length;
    }

    function getRequest(uint256 id) external view returns (Request memory) {
        return _requests[id];
    }

    function openRequestIds() external view returns (uint256[] memory) {
        return _open;
    }

    /// Settings, votes on changes, recovery and Sentinel/Reconciler views live in the VaultModule (same storage
    /// layout). Native value is rejected: USDC is accounted only through its ERC-20 interface.
    fallback() external {
        address m = module;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), m, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}
