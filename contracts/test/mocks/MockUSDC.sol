// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Stand-in for Arc's USDC in fork tests. The real one (0x3600…) calls Arc-only precompiles (blocklist at 0x1800…01,
/// native-balance hooks) that forge's EVM can't execute. Vaults only use the ERC-20 interface, so behaviour is the
/// same; the dual native/ERC-20 balance is covered by the live Arc deploy instead.
contract MockUSDC is ERC20 {
    constructor() ERC20("USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
