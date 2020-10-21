// SPDX-License-Identifier: MIT

pragma solidity >=0.6.0 <=0.7.3;
pragma experimental ABIEncoderV2;

// TODO: Build a Logic Proxy that checks and embeds the version of the state, and directs to other contracts

contract Some_Logic_Contract {
  // User (address) is a mandatory first field
  function initialize_state(address user) external payable returns (bytes32) {
    require(msg.value >= 500000000000000000, "INSUFFICIENT_DEPOSIT");
    return keccak256(abi.encodePacked(user));
  }

  // User (address) is a mandatory first field
  // Current State (bytes32) is a mandatory second field
  function some_pure_transition(
    address user,
    bytes32 current_state,
    bytes32 some_arg
  ) external pure returns (bytes32) {
    // Just do some expensive work for the sake of the proof of concept
    current_state = keccak256(abi.encodePacked(current_state, user));

    for (uint256 i; i < 1000; ++i) {
      current_state = keccak256(abi.encodePacked(current_state, some_arg));
    }

    return current_state;
  }
}
