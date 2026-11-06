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

/// Settings changes (instant tightening, timelocked loosening), Freeze/Guardian/Recovery powers, Safe-harbor swaps
/// and Reconciler views. Runs only via delegatecall from a Vault (same storage layout through VaultBase), so the
/// Vault stays under EIP-170.
contract VaultModule is VaultBase {
    using SafeERC20 for IERC20;

    /// Institution fail-closed path: with CRE silent, a request executes only with the Approver's Payout
    /// approval (confirm) and the Recovery key's approval.
    function recoveryApprove(uint256 id) external onlyRecovery {
        Request storage r = _requests[id];
        if (r.state != T.REQ_PENDING) revert BadState();
        r.recoveryApproved = true;
    }

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
            if (!verifier.verifyPasskey(unfreezeChallenge(), passkeySig, passkeyX, passkeyY)) {
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

    function getChange(uint256 id) external view returns (Change memory) {
        return _changes[id];
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
