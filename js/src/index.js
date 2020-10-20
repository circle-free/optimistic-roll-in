const assert = require('assert');
const { MerkleTree, PartialMerkleTree } = require('merkle-trees/js');
const txDecoder = require('ethereum-tx-decoder');

const { to32ByteBuffer, hashPacked, toHex, toBuffer } = require('./utils');

const proofOptions = { compact: true, simple: true };

class OptimisticRollIn {
  constructor(oriInstance, logicInstance, functions, accountAddress, options = {}) {
    const {
      sourceAddress = accountAddress,
      treeOptions = {},
      optimismDecoder,
      logicDecoder,
      web3,
      parentORI,
    } = options;

    const { elementPrefix = '00' } = treeOptions;

    assert(web3, 'web3 option is mandatory for now.');

    this._web3 = web3;

    this._parentORI = parentORI;

    this._treeOptions = { unbalanced: true, sortedHash: false, elementPrefix };

    this._oriContractInstance = oriInstance;
    this._logicContractInstance = logicInstance;
    // logicInstance.methods is object where keys are human readable function signatures
    // logicInstance.address

    this._sighashes = {};

    logicInstance.abi.forEach(({ name, type, signature, stateMutability }) => {
      if (type !== 'function') return;

      this._sighashes[signature] = name;

      const functionSet = { normal: (...args) => this._pessimisticCall(name, args) };

      if (stateMutability === 'pure' || stateMutability === 'view') {
        Object.assign(functionSet, {
          optimistic: (...args) => this._optimisticCall(name, args),
          queue: (...args) => this._queueCall(name, args),
        });
      }

      Object.assign(this, { [name]: functionSet });
    });

    this._optimismDecoder = optimismDecoder ?? new txDecoder.FunctionDecoder(oriInstance.abi);
    this._logicDecoder = logicDecoder ?? new txDecoder.FunctionDecoder(logicInstance.abi);

    this._functions = functions;
    this._sourceAddress = sourceAddress;

    this._state = {
      user: accountAddress,
      callDataTree: null,
      currentState: null,
      lastTime: null,
      fraudIndex: null,
    };

    this._queue = {
      newStates: [],
      functionNames: [],
      args: [],
    };

    this._frauds = {};
  }

  // STATIC: Creates a new OptimisticRollIn instance, with defined parameters and options
  static fraudsterFromProof(parameters = {}, options = {}) {
    const { suspect, fraudIndex, callDataArrayHex, newStateHex, proofHex, lastTime } = parameters;

    const {
      oriInstance,
      logicInstance,
      functions,
      sourceAddress,
      treeOptions = { elementPrefix: '00' },
      optimismDecoder,
      logicDecoder,
      web3,
      parentORI,
    } = options;

    const oriOptions = {
      sourceAddress,
      optimismDecoder,
      logicDecoder,
      treeOptions,
      web3,
      parentORI,
    };

    const fraudster = new OptimisticRollIn(oriInstance, logicInstance, functions, suspect, oriOptions);

    // Build a partial merkle tree (for the call data) from the proof data pulled from this transaction
    const appendProof = { appendElements: toBuffer(callDataArrayHex), compactProof: toBuffer(proofHex) };
    const callDataPartialTree = PartialMerkleTree.fromAppendProof(appendProof, treeOptions);

    fraudster._state = {
      user: suspect,
      callDataTree: callDataPartialTree,
      currentState: toBuffer(newStateHex),
      lastTime: lastTime,
      fraudIndex: callDataPartialTree.elements.length - callDataArrayHex.length + fraudIndex,
    };

    fraudster._frauds = null;

    return fraudster;
  }

  // GETTER: Returns the current state of the account's data
  get currentState() {
    return this._state.currentState;
  }

  // GETTER: Returns the last optimistic time of the account
  get lastTime() {
    return this._state.lastTime;
  }

  // GETTER: Returns the index of fraud, if it exists
  get fraudIndex() {
    return this._state.fraudIndex;
  }

  // GETTER: Returns the computed account state
  get accountState() {
    return hashPacked([this._state.callDataTree.root, this._state.currentState, to32ByteBuffer(this._state.lastTime)]);
  }

  // GETTER: Returns the number of optimistic transitions of the account
  get transitionCount() {
    // TODO: this only considers on-chain transitions, but not locally queued ones
    return this._state.callDataTree.elements.length;
  }

  // GETTER: Returns if in optimistic state
  get isInOptimisticState() {
    // return !this._state.callDataTree.root.equals(to32ByteBuffer(0)) && this._state.lastTime !== 0;
    return this._state.lastTime !== 0;
  }

  // GETTER: Returns if in optimistic state
  get transitionsQueued() {
    return this._queue.newStates.length;
  }

  // PRIVATE: Updates the state with empty call data tree, computed new state, and 0 last optimistic time
  _updateStatePessimistically(newState) {
    this._state.callDataTree = new MerkleTree([], this._treeOptions);
    this._state.currentState = newState;
    this._state.lastTime = 0;
  }

  // PRIVATE: Updates the state with new call data tree, new state, and last optimistic time
  _updateStateOptimistically(newMerkleTree, newState, lastTime) {
    this._state.callDataTree = newMerkleTree;
    this._state.currentState = newState;
    this._state.lastTime = lastTime;
  }

  // PRIVATE: Creates and stores an ORI instance by cloning current instance, and setting account to fraudulent user's data
  _recordFraud(parameters) {
    const { suspect } = parameters;

    const options = {
      oriInstance: this._oriContractInstance,
      logicInstance: this._logicContractInstance,
      functions: this._functions,
      sourceAddress: this._sourceAddress,
      treeOptions: this._treeOptions,
      optimismDecoder: this._optimismDecoder,
      logicDecoder: this._logicDecoder,
      web3: this._web3,
      parentORI: this,
    };

    this._frauds[suspect] = OptimisticRollIn.fraudsterFromProof(parameters, options);
  }

  _isValidTransition = (callDataHex, newStateHex) => {
    // Decode arg from calldata and compute expected new state
    const { sighash, current_state: startingStateHex, some_arg: somArgHex } = this._logicDecoder.decodeFn(callDataHex);

    const functionName = this._sighashes[sighash];

    // TODO: get the function name based off the decoded data and get all args generically somehow
    const endState = this._functions[functionName](startingStateHex, somArgHex);

    // Fraudulent if the new state computed does not match what was optimistically provided
    return endState.equals(toBuffer(newStateHex));
  };

  // PRIVATE: Verifies an optimistic transition, and creates a fraudster ORI if fraud is found
  _verifyTransition(suspect, decodedOptimismData, lastTime) {
    // Decode the optimism input data
    const { call_data: callDataHex, new_state: newStateHex, proof: proofHex } = decodedOptimismData;

    if (this._isValidTransition(callDataHex, newStateHex)) {
      return { valid: true, user: suspect };
    }

    this._recordFraud({ suspect, fraudIndex: 0, callDataArrayHex: [callDataHex], newStateHex, proofHex, lastTime });

    return { valid: false, user: suspect };
  }

  // PRIVATE: Verifies batch optimistic transitions, and creates a fraudster ORI if fraud is found
  _verifyBatchTransitions(suspect, decodedOptimismData, lastTime) {
    // Decode the optimism input data
    const { call_data: callDataArrayHex, new_state: newStateHex, proof: proofHex } = decodedOptimismData;

    // Compute what the new states should have been, from the original state
    for (let i = 0; i < callDataArrayHex.length; i++) {
      const intermediateStateHex =
        i === callDataArrayHex.length - 1
          ? newStateHex
          : this._logicDecoder.decodeFn(callDataArrayHex[i + 1]).current_state;

      if (this._isValidTransition(callDataArrayHex[i], intermediateStateHex)) continue;

      this._recordFraud({ suspect, fraudIndex: i, callDataArrayHex, newStateHex, proofHex, lastTime });

      return { valid: false, user: suspect };
    }

    return { valid: true, user: suspect };
  }

  // PRIVATE: Updates internal account given some new optimistic transition
  _updateWithTransition(decodedOptimismData, lastTime) {
    // Decode the optimism input data
    const {
      call_data: callDataHex,
      new_state: newStateHex,
      call_data_root: callDataRootHex,
      last_time: originalLastTimeBN,
    } = decodedOptimismData;

    assert(originalLastTimeBN.toNumber() === this._state.lastTime, 'Last time mismatch.');
    assert(toBuffer(callDataRootHex).equals(this._state.callDataTree.root), 'Root mismatch.');

    // Check that this last transition was valid, by decoding arg from calldata and compute expected new state
    const { current_state: startingStateHex } = this._logicDecoder.decodeFn(callDataHex);
    assert(toBuffer(startingStateHex).equals(this._state.currentState), 'State mismatch.');

    const newMerkleTree = this._state.callDataTree.append(toBuffer(callDataHex));
    this._updateStateOptimistically(newMerkleTree, toBuffer(newStateHex), lastTime);
  }

  // PRIVATE: Updates internal account given some new batch optimistic transitions
  _updateWithBatchTransitions(decodedOptimismData, lastTime) {
    // Decode the optimism input data
    const {
      call_data: callDataArrayHex,
      new_state: newStateHex,
      call_data_root: callDataRootHex,
      last_time: originalLastTimeBN,
    } = decodedOptimismData;

    assert(originalLastTimeBN.toNumber() === this._state.lastTime, 'Last time mismatch.');
    assert(toBuffer(callDataRootHex).equals(this._state.callDataTree.root), 'Root mismatch.');

    // Check that this last transition was valid, by decoding arg from calldata and compute expected new state
    const { current_state: startingStateHex } = this._logicDecoder.decodeFn(callDataArrayHex[0]);
    assert(toBuffer(startingStateHex).equals(this._state.currentState), 'State mismatch.');

    const newMerkleTree = this._state.callDataTree.append(toBuffer(callDataArrayHex));
    this._updateStateOptimistically(newMerkleTree, toBuffer(newStateHex), lastTime);
  }

  // PRIVATE: Non-optimistically perform a transition, and update internal state (only for self)
  async _performPessimistically(functionName, args = []) {
    assert(this._sourceAddress === this._state.user, 'Can only initialize own account.');

    // TODO: prevent performing unless out of optimism, or automatically perform and exit

    const callDataHex = await this._getCalldata(this._state.currentState, functionName, args);
    const result = await this._oriContractInstance.perform(callDataHex, { from: this._sourceAddress });

    this._updateStatePessimistically(toBuffer(result.logs[0].args[1]));

    return result;
  }

  // PRIVATE: Non-optimistically perform a transition to exit optimistic state, and update internal state (only for self)
  async _performPessimisticallyWhileExitingOptimism(functionName, args = []) {
    assert(this._sourceAddress === this._state.user, 'Can only initialize own account.');

    // TODO: prevent performing unless in optimism, or automatically perform non-optimistically

    const callDataHex = await this._getCalldata(this._state.currentState, functionName, args);

    const result = await this._oriContractInstance.perform_and_exit(
      callDataHex,
      toHex(this._state.callDataTree.root),
      this._state.lastTime,
      { from: this._sourceAddress }
    );

    this._updateStatePessimistically(toBuffer(result.logs[0].args[1]));

    return result;
  }

  // PRIVATE: Optimistically perform a transition to enter optimistic state, and update internal state (only for self)
  async _performOptimisticallyWhileEnteringOptimism(functionName, args = []) {
    assert(this._sourceAddress === this._state.user, 'Can only initialize own account.');

    // TODO: prevent performing unless out of optimism, or automatically perform optimistically

    const callDataHex = await this._getCalldata(this._state.currentState, functionName, args);

    // Compute the new state from the current state, locally
    const newState = this._functions[functionName](this._state.currentState, ...args);

    // Get the expected new call data tree and append proof
    const { proof, newMerkleTree } = this._state.callDataTree.appendSingle(toBuffer(callDataHex), proofOptions);

    const result = await this._oriContractInstance.perform_optimistically_and_enter(
      callDataHex,
      toHex(newState),
      toHex(proof.compactProof),
      { from: this._sourceAddress }
    );

    // TODO: do not assume logs[0]
    const lastTime = parseInt(result.receipt.logs[0].args[1], 10);

    this._updateStateOptimistically(newMerkleTree, newState, lastTime);

    return result;
  }

  // PRIVATE: Optimistically perform a transition while already in optimistic state, and update internal state (only for self)
  async _performOptimistically(functionName, args = []) {
    assert(this._sourceAddress === this._state.user, 'Can only initialize own account.');

    // TODO: prevent performing unless in optimism, or automatically perform and enter

    const callDataHex = await this._getCalldata(this._state.currentState, functionName, args);

    // Compute the new state from the current state, locally
    const newState = this._functions[functionName](this._state.currentState, ...args);

    // Get the expected new call data tree and append proof
    const { proof, newMerkleTree } = this._state.callDataTree.appendSingle(toBuffer(callDataHex), proofOptions);

    const result = await this._oriContractInstance.perform_optimistically(
      callDataHex,
      toHex(newState),
      toHex(proof.root),
      toHex(proof.compactProof),
      this._state.lastTime,
      { from: this._sourceAddress }
    );

    // TODO: do not assume logs[0]
    const lastTime = parseInt(result.receipt.logs[0].args[1], 10);

    this._updateStateOptimistically(newMerkleTree, newState, lastTime);

    return result;
  }

  // PRIVATE: Optimistically perform batch transitions while already in optimistic state, and update internal state (only for self)
  async _performBatchOptimistically(newStates = [], functionNames = [], args = [], options = {}) {
    const { checkStates = true } = options;

    assert(this._sourceAddress === this._state.user, 'Can only initialize own account.');
    assert(functionNames.length > 0, 'No function calls specified.');
    assert(functionNames.length === args.length, 'Function and args count mismatch.');

    // TODO: prevent performing unless in optimism, or automatically perform many and enter

    // Compute the new state from the current state, locally
    const callDataArray = [];
    let newState = this._state.currentState;

    for (let i = 0; i < functionNames.length; i++) {
      const callDataHex = await this._getCalldata(newState, functionNames[i], args[i]);
      callDataArray.push(toBuffer(callDataHex));

      if (!checkStates) {
        newState = newStates[i];
        continue;
      }

      newState = this._functions[functionNames[i]](newState, ...args[i]);

      assert(newState.equals(newStates[i]), 'New state mismatch.');
    }

    // Get the expected new call data tree and append proof
    const { proof, newMerkleTree } = this._state.callDataTree.appendMulti(callDataArray, proofOptions);

    const result = await this._oriContractInstance.perform_many_optimistically(
      toHex(callDataArray),
      toHex(newState),
      toHex(proof.root),
      toHex(proof.compactProof),
      this._state.lastTime,
      { from: this._sourceAddress }
    );

    // TODO: do not assume logs[0]
    const lastTime = parseInt(result.receipt.logs[0].args[1], 10);

    this._updateStateOptimistically(newMerkleTree, newState, lastTime);

    return result;
  }

  // PRIVATE: Optimistically perform batch transitions to enter optimistic state, and update internal state (only for self)
  async _performBatchOptimisticallyWhileEnteringOptimism(newStates = [], functionNames = [], args = [], options = {}) {
    const { checkStates = false } = options;

    assert(this._sourceAddress === this._state.user, 'Can only initialize own account.');
    assert(functionNames.length > 0, 'No function calls specified.');
    assert(functionNames.length === args.length, 'Function and args count mismatch.');

    // TODO: prevent performing unless out of optimism, or automatically perform optimistically

    // Compute the new state from the current state, locally
    const callDataArray = [];
    let newState = this._state.currentState;

    for (let i = 0; i < functionNames.length; i++) {
      const callDataHex = await this._getCalldata(newState, functionNames[i], args[i]);
      callDataArray.push(toBuffer(callDataHex));

      if (!checkStates) {
        newState = newStates[i];
        continue;
      }

      newState = this._functions[functionNames[i]](newState, ...args[i]);

      assert(newState.equals(newStates[i]), 'New state mismatch.');
    }

    // Get the expected new call data tree and append proof
    const { proof, newMerkleTree } = this._state.callDataTree.appendMulti(callDataArray, proofOptions);

    const result = await this._oriContractInstance.perform_many_optimistically_and_enter(
      toHex(callDataArray),
      toHex(newState),
      toHex(proof.compactProof),
      { from: this._sourceAddress }
    );

    // TODO: do not assume logs[0]
    const lastTime = parseInt(result.receipt.logs[0].args[1], 10);

    this._updateStateOptimistically(newMerkleTree, newState, lastTime);

    return result;
  }

  // PRIVATE: performs a non-optimistic contract call, on-chain
  async _pessimisticCall(functionName, args = []) {
    // if in optimism and can't exit yet, throw
    assert(this.isInOptimisticState || (await this.canExit()), 'In optimistic state and cannot yet exit.');

    // if in optimism and can exit, perform and exit
    if (this.isInOptimisticState) return this._performPessimisticallyWhileExitingOptimism(functionName, args);

    // if not in optimism, perform
    return this._performPessimistically(functionName, args);
  }

  // PRIVATE: performs an optimistic contract call, on-chain
  _optimisticCall(functionName, args = []) {
    // if not in optimism, perform and enter
    if (!this.isInOptimisticState) return this._performOptimisticallyWhileEnteringOptimism(functionName, args);

    // if in optimism, perform optimistically
    return this._performOptimistically(functionName, args);
  }

  // PRIVATE: queues a transition to be broadcasted in batch later
  _queueCall(functionName, args = []) {
    const newStatesLength = this._queue.newStates.length;
    const currentState = newStatesLength ? this._queue.newStates[newStatesLength - 1] : this._state.currentState;

    const newState = this._functions[functionName](currentState, ...args);

    this._queue.newStates.push(newState);
    this._queue.functionNames.push(functionName);
    this._queue.args.push(args);
  }

  // PRIVATE: Returns call data hex needed to call a function, given the current state and args
  async _getCalldata(currentState, functionName, args = []) {
    // Get the call logic contract address and call data from a logic request
    // TODO: this can and should be done locally and synchronously
    const { data: callDataHex } = await this._logicContractInstance[functionName].request(
      toHex(currentState),
      ...args,
      { from: this._sourceAddress }
    );

    return callDataHex;
  }

  // TODO: Returns if can exit optimism
  async canExit() {
    const currentBlockNumber = await this._web3.eth.getBlockNumber();
    const { timestamp } = await this._web3.eth.getBlock(currentBlockNumber);

    // TODO: make threshold an ORI option
    return this._state.lastTime + 600 < timestamp;
  }

  // PUBLIC: Bonds the user's account, using the source address (which may be the same as the user)
  bond(amount) {
    // TODO: prevent over-bonding unless option to force

    const callOptions = { value: amount, from: this._sourceAddress };
    return this._oriContractInstance.bond(this._state.user, callOptions);
  }

  // PUBLIC: Initialize the on-chain account and the internal state (only for self)
  async initialize() {
    assert(this._sourceAddress === this._state.user, 'Can only initialize own account.');

    // TODO: prevent initializing already initialized account

    const result = await this._oriContractInstance.initialize({ from: this._sourceAddress });

    this._updateStatePessimistically(toBuffer(result.logs[0].args[1]));

    return result;
  }

  // PUBLIC: Rolls the entire transition queue into a single transaction and broadcasts (only for self)
  async sendQueue(options = {}) {
    const { checkStates = true } = options;
    const performOptions = { checkStates };

    // if in optimism, perform optimistically, else, perform and enter
    const result = this.isInOptimisticState
      ? await this._performBatchOptimistically(
          this._queue.newStates,
          this._queue.functionNames,
          this._queue.args,
          performOptions
        )
      : await this._performBatchOptimisticallyWhileEnteringOptimism(
          this._queue.newStates,
          this._queue.functionNames,
          this._queue.args,
          performOptions
        );

    this.clearQueue();

    return result;
  }

  // PUBLIC: Clear the queued transitions
  clearQueue() {
    this._queue.newStates.length = 0;
    this._queue.functionNames.length = 0;
    this._queue.args.length = 0;
  }

  // TODO: function to build chain of optimistic transition, without submitting
  async placeholder() {}

  // PUBLIC: Returns an ORI instance (if exists) for a fraudulent user's address
  getFraudster(user) {
    return this._frauds[user.toLowerCase()];
  }

  // PUBLIC: Locks user's account, from the source address (which may be the same as the user)
  lock(options = {}) {
    // TODO: check if suspect already locked
    const { bond = '0' } = options;

    return this._oriContractInstance.lock_user(this._state.user, { value: bond, from: this._sourceAddress });
  }

  // PUBLIC: Updates the internal state given an optimistic tx
  async update(txId) {
    // TODO: should not update unless its a fraudster (partial merkle tree)

    // Pull the transaction containing the suspected fraudulent transition
    const tx = await this._web3.eth.getTransaction(txId);
    const decodedOptimismData = this._optimismDecoder.decodeFn(tx.input);
    const { sighash } = decodedOptimismData;

    // Pull the transaction receipt containing the suspected fraudulent transition's logs
    const receipt = await this._web3.eth.getTransactionReceipt(txId);

    // TODO: search for the correct log (don't assume 0)
    const user = '0x' + receipt.logs[0].topics[1].slice(26);
    assert(user === this._state.user, 'User mismatch.');

    const lastTime = parseInt(receipt.logs[0].topics[2].slice(2), 16);

    if (sighash === '0x08542bb1' || sighash === '0x6a8dddef') {
      return this._updateWithBatchTransitions(decodedOptimismData, lastTime);
    }

    if (sighash === '0x177f15c5' || sighash === '0x1646d051') {
      return this._updateWithTransition(decodedOptimismData, lastTime);
    }

    return;
  }

  // PUBLIC: Verifies the transitions(s) of an optimistic tx, and creates a fraudster ORI if fraud is found
  async verifyTransaction(txId) {
    // Pull the transaction containing the suspected fraudulent transition
    const tx = await this._web3.eth.getTransaction(txId);
    const decodedOptimismData = this._optimismDecoder.decodeFn(tx.input);
    const { sighash } = decodedOptimismData;

    // Pull the transaction receipt containing the suspected fraudulent transition's logs
    const receipt = await this._web3.eth.getTransactionReceipt(txId);

    // TODO: search for the correct log (don't assume 0)
    const suspect = '0x' + receipt.logs[0].topics[1].slice(26);
    const lastTime = parseInt(receipt.logs[0].topics[2].slice(2), 16);

    return sighash === '0x08542bb1' || sighash === '0x6a8dddef'
      ? this._verifyBatchTransitions(suspect, decodedOptimismData, lastTime)
      : sighash === '0x177f15c5' || sighash === '0x1646d051'
      ? this._verifyTransition(suspect, decodedOptimismData, lastTime)
      : { valid: true };
  }

  async proveFraud() {
    // Build a Multi Proof for the call data of the fraudulent transition
    const indices = [this._state.fraudIndex, this._state.fraudIndex + 1];
    const { root, elements, compactProof } = this._state.callDataTree.generateMultiProof(indices, proofOptions);

    // Prove the fraud
    const result = await this._oriContractInstance.prove_fraud(
      this._state.user,
      toHex(elements),
      toHex(this._state.currentState),
      toHex(root),
      toHex(compactProof),
      this._state.lastTime,
      { from: this._sourceAddress }
    );

    // TODO: This is just a hack to prevent re-proving fraud after the first success
    this._state.fraudIndex = null;

    if (this._parentORI) {
      this._parentORI.deleteFraudster(this._state.user);
    }

    return result;
  }

  deleteFraudster(user) {
    this._frauds[user] = null;
  }

  withdraw(destination) {
    return this._oriContractInstance.withdraw(destination, { from: this._sourceAddress });
  }

  async rollback(fraudIndex, options = {}) {
    const { bondAmount = '0' } = options;

    // TODO: check if bond amount is sufficient
    // TODO: detect fraudIndex from chain

    // Need to create a call data Merkle Tree of all pre-invalid-transition call data
    // Note: rollbackSize is a bad name. Its really the expected size of the tree after the rollback is performed
    const oldCallData = this._state.callDataTree.elements.slice(0, fraudIndex);
    const oldCallDataTree = new MerkleTree(oldCallData, this._treeOptions);
    const rolledBackCallDataArray = this._state.callDataTree.elements.slice(fraudIndex);

    // Need to build an Append Proof to prove that the old call data root, when appended with the rolled back call data,
    // has the root that equals the root of current on-chain call data tree
    const { proof } = oldCallDataTree.appendMulti(rolledBackCallDataArray, proofOptions);
    const { root: oldRoot, compactProof: appendProof } = proof;

    // Suspect needs to prove to the current size of the on-chain call data tree
    const { root, elementCount, elementRoot: sizeProof } = this._state.callDataTree.generateSizeProof(proofOptions);

    // Suspect performs the rollback while bonding new coin at the same time
    const result = await this._oriContractInstance.rollback(
      toHex(oldRoot),
      toHex(rolledBackCallDataArray),
      toHex(appendProof),
      elementCount,
      toHex(sizeProof),
      toHex(root),
      toHex(this._state.currentState),
      this._state.lastTime,
      { value: bondAmount, from: this._sourceAddress }
    );

    // TODO: do not assume logs[0]
    const lastTime = parseInt(result.receipt.logs[0].args[2], 10);

    const currentState = rolledBackCallDataArray[0].slice(4, 36);
    this._updateStateOptimistically(oldCallDataTree, currentState, lastTime);

    // TODO: this is weird, because this isn't here for the suspect's own ori instance
    this._state.fraudIndex = null;

    return result;
  }
}

module.exports = OptimisticRollIn;
