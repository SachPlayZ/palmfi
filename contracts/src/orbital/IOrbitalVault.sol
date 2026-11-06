// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Seam between OrbitalHook and an org Vault (implemented by Vault; mocked in test/orbital).
interface IOrbitalVault {
    /// @notice The vault's Protected token.
    function token() external view returns (address);

    function isFrozen() external view returns (bool);

    /// @notice Whitelisted wallet of this vault.
    function isWallet(address a) external view returns (bool);

    /// @notice onlyHook. Consumes `wallet`'s instant budget; reverts over budget (use requestPayment).
    function chargeOutflow(address wallet, uint256 amount) external;

    /// @notice onlyHook. Moves `amount` USDC backing to `toVault`; burns pool-held tokens.
    function settleOut(uint256 amount, address toVault) external;

    /// @notice onlyHook. Called on the receiving vault; mints `amount` tokens to the PoolManager/hook.
    function settleIn(uint256 amount) external;
}
