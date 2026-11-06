// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {External} from "./SepoliaConfig.sol";

/// palmfi contracts deployed on top of External. Grows as tickets add contracts.
struct Deployment {
    address deployer;
    uint256 blockNumber;
}

/// Single deploy path shared by the Sepolia deploy script and the fork test base,
/// so tests always exercise exactly what ships.
abstract contract NetworkDeployer {
    function deployNetwork(External memory, address deployer) internal view returns (Deployment memory d) {
        d.deployer = deployer;
        d.blockNumber = block.number;
    }
}
