// SPDX-License-Identifier: MIT

pragma solidity <=0.7.3;
pragma experimental ABIEncoderV2;

import "../node_modules/merkle-trees/eth/contracts/libraries/memory/bytes32/standard/merkle-library.sol";

contract Game_Collectibles {
  event Packs_Purchased(uint256 indexed pack_count);
  event Cards_Opened(uint256 indexed total_card_count);

  // Impure, payable, and therefore not possible as an optimistic transition
  function buy_packs(bytes32 current_state, uint256 pack_count, bytes32 pack_root, bytes32[] calldata pack_append_proof, bytes32 cards_root) external payable returns (bytes32 new_state) {
    // Payment for the packs must be exact
    require(msg.value == (1000 gwei) * pack_count, "INCORRECT_PAYMENT");

    // Check that user's provided pack and card roots match their current state
    require(keccak256(abi.encodePacked(pack_root, cards_root)) == current_state, "INVALID_USER_ROOTS");

    // Build random pack data
    bytes32[] memory packs = new bytes32[](pack_count);
    for (uint256 i; i < pack_count; ++i) {
      packs[0] = keccak256(abi.encodePacked(block.timestamp, current_state, i));
    }

    // Append packs to user's packs root
    pack_root = Merkle_Library_MB32S.try_append_many(pack_root, packs, pack_append_proof);

    emit Packs_Purchased(pack_count);

    // returns new user state
    new_state = keccak256(abi.encodePacked(pack_root, cards_root));
  }

  // Pure and therefore possible as an optimistic transition
  function open_pack(bytes32 current_state, uint256 pack_index, bytes32 pack_data, bytes32 pack_root, bytes32[] calldata pack_proof, bytes32 cards_root, bytes32[] calldata cards_append_proof) external pure returns (bytes32 new_state) {
    // Check that user's provided pack and card roots match their current state
    require(keccak256(abi.encodePacked(pack_root, cards_root)) == current_state, "INVALID_USER_ROOTS");

    // Build random card data
    bytes32[] memory cards = new bytes32[](10);
    for (uint256 i; i < 10; ++i) {
      cards[0] = keccak256(abi.encodePacked(pack_data, i));
    }

    // Clear pack to user's packs root
    pack_root = Merkle_Library_MB32S.try_update_one(pack_root, pack_index, pack_data, bytes32(0), pack_proof);

    // Append cards to user's cards root
    cards_root = Merkle_Library_MB32S.try_append_many(cards_root, cards, cards_append_proof);

    // returns new user state
    new_state = keccak256(abi.encodePacked(pack_root, cards_root));
  }
}
