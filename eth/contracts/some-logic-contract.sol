// SPDX-License-Identifier: MIT

pragma solidity >=0.6.0 <=0.7.3;
pragma experimental ABIEncoderV2;

// TODO: Build a Logic Proxy that checks and embeds the version of the state, and directs to other contracts

contract Some_Logic_Contract {
  function get_initial_state() external pure returns (bytes32) {
    return bytes32(0);
  }

  function some_pure_transition(bytes32 current_state, bytes32 some_arg) external pure returns (bytes32) {
    // Just do some expensive work for the sake of the proof of concept
    for (uint256 i; i < 1000; ++i) {
      current_state = keccak256(abi.encodePacked(current_state, some_arg));
    }

    return current_state;
  }
}
