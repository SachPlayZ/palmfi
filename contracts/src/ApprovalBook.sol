// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// Where an Institution's Approver posts EIP-712 Payout approvals (ADR-0002). The Sentinel reads them here;
/// the Vault verifies the signature itself (confirm), so the book stores but never authorizes anything.
contract ApprovalBook is EIP712 {
    bytes32 public constant PAYOUT_TYPEHASH = keccak256(
        "PayoutApproval(address vault,bytes32 requestHash,uint256 amount,address asset,address destination,uint64 expiry)"
    );

    struct Approval {
        uint256 requestId;
        uint256 amount;
        address asset;
        address destination;
        uint64 expiry;
        bytes signature;
    }

    /// vault => requestHash => approval
    mapping(address => mapping(bytes32 => Approval)) internal _approvals;

    event PayoutApprovalPosted(
        address indexed vault, uint256 indexed requestId, bytes32 indexed requestHash, uint64 expiry, bytes signature
    );

    constructor() EIP712("palmfi ApprovalBook", "1") {}

    function payoutDigest(
        address vault,
        bytes32 requestHash,
        uint256 amount,
        address asset,
        address destination,
        uint64 expiry
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(PAYOUT_TYPEHASH, vault, requestHash, amount, asset, destination, expiry))
        );
    }

    /// Anyone may post (the Approver view does); a wrong signature simply fails at the Vault.
    function post(
        address vault,
        uint256 requestId,
        bytes32 requestHash,
        uint256 amount,
        address asset,
        address destination,
        uint64 expiry,
        bytes calldata signature
    ) external {
        _approvals[vault][requestHash] = Approval(requestId, amount, asset, destination, expiry, signature);
        emit PayoutApprovalPosted(vault, requestId, requestHash, expiry, signature);
    }

    function get(address vault, bytes32 requestHash) external view returns (Approval memory) {
        return _approvals[vault][requestHash];
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
