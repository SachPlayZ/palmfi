// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {External} from "./ArcConfig.sol";
import {Hub} from "../../src/Hub.sol";
import {Vault} from "../../src/Vault.sol";
import {VaultModule} from "../../src/VaultModule.sol";
import {VaultFactory} from "../../src/VaultFactory.sol";
import {ProtectedToken} from "../../src/tokens/ProtectedToken.sol";

struct Deployment {
    address hub;
    address factory;
    address vaultImpl;
    address vaultModule;
    address tokenImpl;
    address deployer;
    uint256 blockNumber;
}

/// Shared by the Deploy script and the fork tests, so tests exercise exactly what ships.
/// The Hub starts on the CRE simulation forwarder; `Hub.pinWorkflow` switches to the live forwarder once.
abstract contract NetworkDeployer {
    function deployNetwork(External memory e, address deployer) internal returns (Deployment memory d) {
        d.deployer = deployer;
        d.blockNumber = block.number;
        Hub hub = new Hub(deployer, e.creSimForwarder);
        d.hub = address(hub);
        d.vaultImpl = address(new Vault());
        d.vaultModule = address(new VaultModule());
        d.tokenImpl = address(new ProtectedToken());

        address[] memory delegates = new address[](1);
        delegates[0] = e.metamaskDelegator;
        VaultFactory f = new VaultFactory(
            VaultFactory.Wiring(
                deployer, d.hub, e.usdc, e.poolManager, d.vaultImpl, d.vaultModule, d.tokenImpl, delegates
            )
        );
        d.factory = address(f);
        hub.setFactory(d.factory);
    }
}
