// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PalmTypes as T} from "./libraries/PalmTypes.sol";
import {ProtectedToken} from "./tokens/ProtectedToken.sol";
import {VaultBase} from "./VaultBase.sol";
import {IVault} from "./interfaces/IPalm.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// The Orbital hook as a Frozen Vault's Lifeline sees it (ADR-0013).
interface ILifelineHook {
    function lifelineDraw(address payeeVault, uint256 amount, uint256 fee) external;
}

/// Settings changes by majority vote (instant tightening by any one wallet, timelocked loosening), recovery, and the
/// Sentinel/Reconciler views. Runs only via delegatecall from a Vault (same storage layout through VaultBase), so the
/// Vault stays under EIP-170.
contract VaultModule is VaultBase {
    using SafeERC20 for IERC20;

    event LifelineProposed(uint256 indexed id, address indexed payee, address proposer, uint256 amount, uint256 fee);
    event LifelineApproved(uint256 indexed id, address by, uint16 yes, bool keyApproved);
    event LifelineDrawn(uint256 indexed id, address indexed payee, uint256 amount, uint256 fee);
    event LifelineCancelled(uint256 indexed id);
    event LifelineRepaid(address indexed payee, uint256 principal, uint256 fee);
    // ------------------------------------------------------------------
    // Tightening: instant, any one wallet
    // ------------------------------------------------------------------

    function lowerBudget(uint128 b24, uint128 b7) external onlyWallet {
        if (b24 > budget24h || b7 > budget7d) revert NotTightening();
        budget24h = b24;
        budget7d = b7;
    }

    function tightenLimits(uint128 cap, uint32 floor_, uint32 max_, uint32 capDelay_) external onlyWallet {
        if (cap > hardCap || floor_ < floorDelay || max_ < maxDelay || capDelay_ < capDelay) revert NotTightening();
        _checkLimits(floor_, max_, capDelay_);
        hardCap = cap;
        floorDelay = floor_;
        maxDelay = max_;
        capDelay = capDelay_;
    }

    function removeDestination(address d) external onlyWallet {
        isDestination[d] = false;
    }

    function removeDelegate(address d) external onlyWallet {
        isApprovedDelegate[d] = false;
    }

    /// A wallet can always leave (e.g. its key is suspect), as long as the Vault keeps MIN_WALLETS.
    function leave() external {
        if (!isWallet[msg.sender]) revert NotWallet();
        _removeWallet(msg.sender);
    }

    // ------------------------------------------------------------------
    // Changes: any wallet proposes, a majority of the snapshot passes, the timelock runs, anyone executes
    // ------------------------------------------------------------------

    function proposeChange(uint8 kind, bytes calldata data) external onlyWallet returns (uint256 id) {
        if (kind < T.CHANGE_ADD_WALLET || kind > T.CHANGE_MIGRATE) revert BadKind();
        if (kind == T.CHANGE_ADD_WALLET) {
            abi.decode(data, (address));
            pendingWalletAdds++;
        } else if (kind == T.CHANGE_LIMITS) {
            (, uint32 f, uint32 m, uint32 cd) = abi.decode(data, (uint128, uint32, uint32, uint32));
            _checkLimits(f, m, cd);
        }
        id = ++nextChangeId;
        Change storage c = _changes[id];
        c.kind = kind;
        c.voterCount = uint16(_wallets.length);
        c.createdAt = uint64(block.timestamp);
        c.data = data;
        _voteChange(id, c);
    }

    function voteChange(uint256 id) external onlyWallet {
        Change storage c = _changes[id];
        if (c.createdAt == 0 || c.done || c.eta != 0) revert BadState();
        if (walletAddedAt[msg.sender] > c.createdAt) revert NotEligible();
        _voteChange(id, c);
    }

    function _voteChange(uint256 id, Change storage c) internal {
        if (hasVotedChange[id][msg.sender]) revert AlreadyVoted();
        hasVotedChange[id][msg.sender] = true;
        c.yes++;
        if (_majority(c.yes, c.voterCount)) {
            c.eta = uint64(block.timestamp + _timelock(c.kind));
            if (c.eta == block.timestamp) _apply(c);
        }
        hub.emitConfigChange(id, c.kind, c.data, c.yes, c.eta);
    }

    function executeChange(uint256 id) external {
        Change storage c = _changes[id];
        if (c.done || c.eta == 0) revert BadState();
        if (block.timestamp < c.eta) revert TimelockActive();
        _apply(c);
    }

    /// Any wallet can drop a loosening change a majority hasn't passed (e.g. an attacker's wallet-add). Protective
    /// changes (remove wallet, unfreeze, migrate) can't be cancelled, or one hacked wallet could block recovery.
    function cancelChange(uint256 id) external onlyWallet {
        Change storage c = _changes[id];
        if (c.createdAt == 0 || c.done || c.eta != 0) revert BadState();
        if (c.kind == T.CHANGE_REMOVE_WALLET || c.kind == T.CHANGE_UNFREEZE || c.kind == T.CHANGE_MIGRATE) {
            revert NotCancellable();
        }
        c.done = true;
        if (c.kind == T.CHANGE_ADD_WALLET) pendingWalletAdds--;
    }

    function _timelock(uint8 kind) internal pure returns (uint256) {
        if (kind == T.CHANGE_REMOVE_WALLET || kind == T.CHANGE_UNFREEZE || kind == T.CHANGE_MIGRATE) return 0;
        if (kind == T.CHANGE_RECOVERY_VAULT || kind == T.CHANGE_RECOVERY_KEY) return LONG_TIMELOCK;
        return SHORT_TIMELOCK;
    }

    function _apply(Change storage c) internal {
        c.done = true;
        uint8 k = c.kind;
        bytes memory d = c.data;
        if (k == T.CHANGE_ADD_WALLET) {
            pendingWalletAdds--;
            _addWallet(abi.decode(d, (address)));
        } else if (k == T.CHANGE_REMOVE_WALLET) {
            _removeWallet(abi.decode(d, (address)));
        } else if (k == T.CHANGE_BUDGET) {
            (budget24h, budget7d) = abi.decode(d, (uint128, uint128));
        } else if (k == T.CHANGE_LIMITS) {
            (hardCap, floorDelay, maxDelay, capDelay) = abi.decode(d, (uint128, uint32, uint32, uint32));
        } else if (k == T.CHANGE_ADD_DESTINATION) {
            isDestination[abi.decode(d, (address))] = true;
        } else if (k == T.CHANGE_ADD_DELEGATE) {
            isApprovedDelegate[abi.decode(d, (address))] = true;
        } else if (k == T.CHANGE_RECOVERY_VAULT) {
            recoveryVault = abi.decode(d, (address));
        } else if (k == T.CHANGE_RECOVERY_KEY) {
            recoveryKey = abi.decode(d, (address));
        } else if (k == T.CHANGE_UNFREEZE) {
            hub.vaultUnfreeze();
        } else {
            _migrate();
        }
    }

    // ------------------------------------------------------------------
    // Recovery key (optional, cold): unfreeze or migrate, never spend
    // ------------------------------------------------------------------

    function recoveryUnfreeze() external {
        if (msg.sender != recoveryKey || recoveryKey == address(0)) revert NotRecoveryKey();
        hub.vaultUnfreeze();
    }

    function recoveryMigrate() external {
        if (msg.sender != recoveryKey || recoveryKey == address(0)) revert NotRecoveryKey();
        _migrate();
    }

    // ------------------------------------------------------------------
    // Lifeline (ADR-0013): keep paying known counterparties while Frozen
    // ------------------------------------------------------------------

    /// Any wallet proposes paying `amount` to a payee Vault this Vault already paid before the freeze (its
    /// history or onboarding destinations: the vote never chooses where money goes, ADR-0004/0008). The amount
    /// plus fee is escrowed by burning the proposer's tokens; the frozen USDC itself does not move.
    function proposeLifeline(address payeeVault, uint256 amount) external onlyWallet returns (uint256 id) {
        if (hub.statusOf(address(this)) != T.STATUS_FROZEN) revert NotFrozen();
        if (recoveryKey == address(0)) revert NotRecoveryKey();
        if (amount == 0) revert ZeroAmount();
        if (!factory.isVault(payeeVault) || payeeVault == address(this)) revert NotFactoryVault();
        if (destinationCount[payeeVault] == 0 && !isDestination[payeeVault]) revert UnknownPayee(payeeVault);
        uint256 fee = amount * LIFELINE_FEE_BPS / 10_000;
        uint256 room = lifelineRoom();
        if (amount + fee > room) revert OverLifelineCap(amount + fee, room);

        ProtectedToken(token).burn(msg.sender, amount + fee);
        lifelinePending += amount + fee;
        id = ++nextLifelineId;
        Lifeline storage l = _lifelines[id];
        l.payee = payeeVault;
        l.proposer = msg.sender;
        l.amount = uint128(amount);
        l.fee = uint128(fee);
        l.createdAt = uint64(block.timestamp);
        l.voterCount = uint16(_wallets.length);
        l.state = 1;
        emit LifelineProposed(id, payeeVault, msg.sender, amount, fee);
        _approveLifeline(id, l);
    }

    /// Needs both the Recovery key (which a hot-wallet compromise doesn't reach) and a majority of the wallets.
    function approveLifeline(uint256 id) external {
        Lifeline storage l = _lifelines[id];
        if (l.state != 1) revert BadState();
        _approveLifeline(id, l);
    }

    function _approveLifeline(uint256 id, Lifeline storage l) internal {
        if (msg.sender == recoveryKey) {
            if (l.keyApproved) revert AlreadyVoted();
            l.keyApproved = true;
        } else {
            _checkWallet(msg.sender);
            if (walletAddedAt[msg.sender] > l.createdAt) revert NotEligible();
            if (hasVotedLifeline[id][msg.sender]) revert AlreadyVoted();
            hasVotedLifeline[id][msg.sender] = true;
            l.yes++;
        }
        emit LifelineApproved(id, msg.sender, l.yes, l.keyApproved);
        if (!l.keyApproved || !_majority(l.yes, l.voterCount)) return;
        // Still frozen: once unfrozen the ordinary queued lane applies; once migrated nothing more leaves.
        if (hub.statusOf(address(this)) != T.STATUS_FROZEN) revert NotFrozen();
        uint256 owed = uint256(l.amount) + l.fee;
        l.state = 2;
        lifelinePending -= owed;
        lifelineDebt += owed;
        _record(l.proposer, l.payee, l.amount);
        hub.emitOutflow(l.proposer, l.payee, l.amount, true);
        ILifelineHook(factory.hook()).lifelineDraw(l.payee, l.amount, l.fee);
        emit LifelineDrawn(id, l.payee, l.amount, l.fee);
    }

    /// The proposer, or anyone after REQUEST_TTL. The escrow comes back unless the Vault migrated (its USDC went
    /// to the Recovery vault, so re-minting would be unbacked).
    function cancelLifeline(uint256 id) external {
        Lifeline storage l = _lifelines[id];
        if (l.state != 1) revert BadState();
        if (msg.sender != l.proposer && block.timestamp <= l.createdAt + REQUEST_TTL) revert Unauthorized();
        uint256 owed = uint256(l.amount) + l.fee;
        l.state = 3;
        lifelinePending -= owed;
        if (hub.statusOf(address(this)) != T.STATUS_MIGRATED) {
            ProtectedToken(token).mint(isWallet[l.proposer] ? l.proposer : _wallets[0], owed);
        }
        emit LifelineCancelled(id);
    }

    /// Hook-only repayment once the freeze resolved (unfrozen, or migrated with the debt kept back): principal
    /// and fee in USDC to the payee Vault, which mints the fee to its wallets (the principal the hook mints back
    /// into the pool).
    function repayLifeline(uint256 principal, uint256 fee, address payeeVault) external onlyHook {
        uint8 s = hub.statusOf(address(this));
        if (s != T.STATUS_ACTIVE && s != T.STATUS_MIGRATED) revert NotActive();
        lifelineDebt -= principal + fee;
        IERC20(usdc).safeTransfer(payeeVault, principal + fee);
        if (fee != 0) IVault(payeeVault).receivePayment(fee);
        emit LifelineRepaid(payeeVault, principal, fee);
    }

    /// How much more (amount + fee) Lifelines may still take.
    function lifelineRoom() public view returns (uint256) {
        uint256 cap = IERC20(usdc).balanceOf(address(this)) * LIFELINE_CAP_BPS / 10_000;
        uint256 used = lifelinePending + lifelineDebt;
        return cap > used ? cap - used : 0;
    }

    function getLifeline(uint256 id) external view returns (Lifeline memory) {
        return _lifelines[id];
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function getChange(uint256 id) external view returns (Change memory) {
        return _changes[id];
    }

    /// Executed outflows, oldest first (≤ HISTORY).
    function history() public view returns (T.Outflow[] memory out) {
        uint256 n = historyCount < HISTORY ? historyCount : HISTORY;
        out = new T.Outflow[](n);
        uint256 start = historyCount - n;
        for (uint256 i; i < n; i++) {
            out[i] = _history[(start + i) % HISTORY];
        }
    }

    struct Profile {
        uint8 bizStartHourUtc;
        uint8 bizEndHourUtc;
        uint128 usualMaxPayout;
        uint128 hardCap;
        uint32 floorDelay;
        uint32 maxDelay;
        uint32 capDelay;
    }

    struct ScoringContext {
        Request request;
        T.Outflow[] history;
        uint256 destinationCount;
        bool knownDestination;
        Profile profile;
        bool configChangePending;
        uint64 requesterAddedAt;
        address requesterDelegation;
        uint256 walletCount;
    }

    /// Everything the Sentinel needs to score one request, in one EVM read (CRE quota: 15 reads/execution).
    function scoringContext(uint256 id) external view returns (ScoringContext memory ctx) {
        Request memory r = _requests[id];
        ctx.request = r;
        ctx.history = history();
        ctx.destinationCount = destinationCount[r.destination];
        ctx.knownDestination = isDestination[r.destination];
        ctx.profile = Profile(bizStartHourUtc, bizEndHourUtc, usualMaxPayout, hardCap, floorDelay, maxDelay, capDelay);
        ctx.configChangePending = pendingWalletAdds > 0;
        ctx.requesterAddedAt = walletAddedAt[r.requester];
        ctx.requesterDelegation = delegationOf(r.requester);
        ctx.walletCount = _wallets.length;
    }

    /// Reconciler: reserves vs supply.
    function reserves() external view returns (uint256 held, uint256 supply) {
        held = IERC20(usdc).balanceOf(address(this));
        supply = ProtectedToken(token).totalSupply();
    }

    /// Reconciler: each wallet's 7702 delegation target and whether it is approved.
    function delegations() external view returns (address[] memory ws, address[] memory targets, bool[] memory ok) {
        ws = _wallets;
        targets = new address[](ws.length);
        ok = new bool[](ws.length);
        for (uint256 i; i < ws.length; i++) {
            targets[i] = delegationOf(ws[i]);
            ok[i] = targets[i] == address(0) || isApprovedDelegate[targets[i]];
        }
    }
}
