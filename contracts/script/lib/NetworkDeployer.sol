// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {External} from "./SepoliaConfig.sol";
import {Hub} from "../../src/Hub.sol";
import {NetworkRegistry} from "../../src/NetworkRegistry.sol";
import {SafetyFund} from "../../src/SafetyFund.sol";
import {ApprovalBook} from "../../src/ApprovalBook.sol";
import {Vault} from "../../src/Vault.sol";
import {VaultFactory} from "../../src/VaultFactory.sol";
import {ProtectedToken} from "../../src/tokens/ProtectedToken.sol";

/// palmfi contracts deployed on top of External.
struct Deployment {
    address deployer;
    uint256 blockNumber;
    address hub;
    address registry;
    address safetyFund;
    address approvalBook;
    address factory;
    address vaultImpl;
    address tokenImpl;
    address ensUserRegistry;
    address ensResolver;
}

struct EnsGrant {
    address account;
    uint256 roleBitmap;
}

interface IVerifiableFactory {
    function deployProxy(address implementation, uint256 salt, bytes memory data) external returns (address);
}

interface IUserRegistryInit {
    function initialize(EnsGrant[] calldata grants) external;
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
}

interface IResolverInit {
    function initialize(EnsGrant[] calldata grants, bytes[] calldata calls) external;
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function grantSetterRoles(bytes calldata setter, address account) external returns (bool);
}

interface IEthRegistry {
    function setSubregistry(uint256 anyId, address registry) external;
}

/// Single deploy path shared by the Sepolia deploy script and the fork test base,
/// so tests always exercise exactly what ships. Must run with `deployer` as the sender
/// (broadcast in the script, prank in tests); the deployer must own the ENS parent name.
abstract contract NetworkDeployer {
    string internal constant PARENT_LABEL = "palmfi";
    uint256 internal constant ENS_ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111;
    uint256 internal constant REG_ROLE_REGISTRAR = 1 << 0;
    uint256 internal constant REG_ROLE_UNREGISTER = 1 << 12;
    uint256 internal constant RES_ROLE_SET_ADDRESS = 1 << 0;

    function deployNetwork(External memory e, address deployer) internal returns (Deployment memory d) {
        d.deployer = deployer;
        d.blockNumber = block.number;
        uint256 salt = uint256(keccak256(abi.encode("palmfi", block.number, block.timestamp)));

        // --- ENSv2 (research option A): UserRegistry under palmfi.eth + shared PermissionedResolver ---
        EnsGrant[] memory g = new EnsGrant[](1);
        g[0] = EnsGrant(deployer, ENS_ALL_ROLES);
        d.ensUserRegistry = IVerifiableFactory(e.ensVerifiableFactory)
            .deployProxy(e.ensUserRegistryImpl, salt, abi.encodeCall(IUserRegistryInit.initialize, (g)));
        d.ensResolver = IVerifiableFactory(e.ensVerifiableFactory)
            .deployProxy(
                e.ensPermissionedResolverImpl, salt + 1, abi.encodeCall(IResolverInit.initialize, (g, new bytes[](0)))
            );
        IEthRegistry(e.ensEthRegistry).setSubregistry(uint256(keccak256(bytes(PARENT_LABEL))), d.ensUserRegistry);

        // --- network ---
        Hub hub = new Hub(deployer, e.creSimForwarder, d.ensResolver);
        NetworkRegistry reg = new NetworkRegistry(deployer, address(hub), e.voteWindow);
        d.hub = address(hub);
        d.registry = address(reg);
        d.safetyFund = address(new SafetyFund(address(reg)));
        d.approvalBook = address(new ApprovalBook());
        d.vaultImpl = address(new Vault());
        d.tokenImpl = address(new ProtectedToken());

        VaultFactory.ListedAsset[] memory listed = new VaultFactory.ListedAsset[](2);
        listed[0] = VaultFactory.ListedAsset(e.usdc, e.usdcUsdFeed, e.usdcUsdHeartbeat, "pUSDC");
        listed[1] = VaultFactory.ListedAsset(e.weth, e.ethUsdFeed, e.ethUsdHeartbeat, "pETH");
        address[] memory delegates = new address[](1);
        delegates[0] = e.metamaskDelegator;
        d.factory = address(
            new VaultFactory(
                VaultFactory.Wiring({
                    admin: deployer,
                    hub: d.hub,
                    registry: d.registry,
                    safetyFund: d.safetyFund,
                    approvalBook: d.approvalBook,
                    vaultImpl: d.vaultImpl,
                    tokenImpl: d.tokenImpl,
                    poolManager: e.poolManager,
                    weth: e.weth,
                    usdc: e.usdc,
                    ensRegistry: d.ensUserRegistry,
                    ensResolver: d.ensResolver,
                    parentDnsName: abi.encodePacked(
                        uint8(bytes(PARENT_LABEL).length), PARENT_LABEL, hex"03657468", hex"00"
                    ),
                    defaultDelegates: delegates
                }),
                listed
            )
        );
        hub.setWiring(d.factory, d.registry);
        reg.setWiring(d.factory, d.safetyFund);

        // --- ENS permissions: factory registers/revokes names and writes its keys; Hub writes `status` only ---
        IUserRegistryInit(d.ensUserRegistry).grantRootRoles(REG_ROLE_REGISTRAR | REG_ROLE_UNREGISTER, d.factory);
        IResolverInit res = IResolverInit(d.ensResolver);
        string[6] memory factoryKeys = ["type", "verified", "tokens", "status", "url", "avatar"];
        for (uint256 i; i < factoryKeys.length; i++) {
            res.grantSetterRoles(_textSetter(factoryKeys[i]), d.factory);
        }
        res.grantRootRoles(RES_ROLE_SET_ADDRESS, d.factory);
        res.grantSetterRoles(_textSetter("status"), d.hub);
    }

    function _textSetter(string memory key) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("setText(bytes,string,string)", bytes(""), key, "");
    }
}
