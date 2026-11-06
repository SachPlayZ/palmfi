// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// Shared backstop. Receives USDC from TJAR releases and forfeited request bonds (ETH).
/// Pays out only when a passed Vote executes through the NetworkRegistry.
contract SafetyFund {
    using SafeERC20 for IERC20;

    address public immutable registry;

    event Payout(address indexed token, address indexed to, uint256 amount);

    error OnlyRegistry();

    constructor(address registry_) {
        registry = registry_;
    }

    receive() external payable {}

    function payout(address token, address to, uint256 amount) external {
        if (msg.sender != registry) revert OnlyRegistry();
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            require(ok, "eth");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
        emit Payout(token, to, amount);
    }
}
