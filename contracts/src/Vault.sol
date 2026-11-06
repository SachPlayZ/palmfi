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
import {VaultBase} from "./VaultBase.sol";

/// One Owner's Vault (EIP-1167 clone, immutable once initialized). Holds the Underlying, mints/burns the
/// Owner's Protected tokens and enforces every spending rule. Institutions and Individuals share this code.
contract Vault is VaultBase {
    using SafeERC20 for IERC20;

    function initialize(T.VaultConfig calldata c, Wiring calldata w) external {
        if (address(factory) != address(0)) revert Unauthorized();
        factory = IVaultFactory(msg.sender);
        hub = IHub(w.hub);
        registry = w.registry;
        weth = w.weth;
        usdc = w.usdc;
        safetyFund = w.safetyFund;
        approvalBook = ApprovalBook(w.approvalBook);
        verifier = SecondFactorVerifier(w.verifier);
        module = w.module;

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
            if (!verifier.verifyEcdsa(digest, ecdsaSig, approver)) revert BadSignature();
        } else {
            if (!verifier.verifyPasskey(r.requestHash, sig, passkeyX, passkeyY)) revert BadSignature();
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

    function openRequestIds() external view returns (uint256[] memory) {
        return _open;
    }

    /// Settings, recovery, Safe-harbor and Reconciler views live in the VaultModule (same storage layout).
    fallback() external payable {
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
