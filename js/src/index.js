const assert = require('assert');
const { MerkleTree, PartialMerkleTree } = require('merkle-trees/js');
const txDecoder = require('ethereum-tx-decoder');

const { to32ByteBuffer, hashPacked, prefix, toHex, toBuffer, compareHex } = require('./utils');

const PROOF_OPTIONS = { compact: true, simple: true };

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES_32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

const SIG_HASHES = {
  PerformManyOptimisticallyAndEnter: '0x08542bb1',
  PerformManyOptimistically: '0x6a8dddef',
  PerformOptimisticallyAndEnter: '0x177f15c5',
  PerformOptimistically: '0x1646d051',
};

const EVENTS = {
  ORI_Fraud_Proven: 'ORI_Fraud_Proven',
  ORI_Locked: 'ORI_Locked',
  ORI_New_Optimistic_State: 'ORI_New_Optimistic_State',
  ORI_New_Optimistic_States: 'ORI_New_Optimistic_States',
  ORI_New_State: 'ORI_New_State',
  ORI_Rolled_Back: 'ORI_Rolled_Back',
  ORI_Unlocked: 'ORI_Unlocked',
};

const TOPICS = {
  ORI_Fraud_Proven: '0xa66290bc21cee2ba1a3c6ba2cac21d24511cea1f9ed7efe453736f24fd894886',
  ORI_Locked: '0x8773bde6581ad6ddd421210de867340039fb65ce3df41edba7b5de6d24ae7a51',
  ORI_New_Optimistic_State: '0x4779c4b07abff82b16061ec9a47d081e7f4981c29088395cdb7ff87e322cbbc6',
  ORI_New_Optimistic_States: '0x0b87b136840d19f5f25329273082c00833265a189b70137e06df6315ddc7839e',
  ORI_New_State: '0x0f5025cc4f20aa47a346d1b7d9da6ba8c68cc8e83b75e813da4b4490d55365ae',
  ORI_Rolled_Back: '0x4d7ed8c49e6b03daee23a18f4bd14bd7e4628e5ed54c57bf84407a693867eca9',
  ORI_Unlocked: '0x524512344e535e9bda79e916c2ea8c7b9e5d23d83e1b95181d7622b4ac3d4293',
};

// TODO: smart local gas estimates as default
// TODO: check if account locked for all performs (maybe not, might be slow)

const binarySearchGasCost = async (
  callDataArray,
  newStatesArray,
  gasEstimator,
  searchValue,
  left = 0,
  right = callDataArray.length
) => {
  const cache = {};

  while (left < right) {
    const mid = (left + right) >> 1;
    const valueAtMid =
      cache[mid] ?? (cache[mid] = await gasEstimator(callDataArray.slice(0, mid + 1), newStatesArray[mid]));

    if (searchValue < valueAtMid) {
      right = mid;
    } else {
      left = mid + 1;
    }
  }

  return left - 1;
};

class OptimisticRollIn {
  constructor(accountAddress, contracts = {}, options = {}) {
    const { oriAddress, oriABI, logicAddress, logicABI } = contracts;

    const {
      oriContract,
      logicContract,
      sourceAddress = accountAddress,
      treeOptions = {},
      optimismDecoder,
      logicDecoder,
      web3,
      ethers,
      ethersSigner,
      parentORI,
      requiredBond,
      lockTime,
    } = options;

    const { elementPrefix = '00' } = treeOptions;

    assert(
      ethers && ethersSigner ? !web3 : web3,
      'either web3 or ethers (and ethersSigner) option is mandatory for now.'
    );
    assert(requiredBond, 'requiredBond option is mandatory for now.');
    assert(lockTime, 'lockTime option is mandatory for now.');

    this._web3 = web3;
    this._ethers = ethers;
    this._ethersSigner = ethersSigner;
    this._requiredBond = BigInt(requiredBond);
    this._lockTime = Number(lockTime);

    this._parentORI = parentORI;

    this._treeOptions = { unbalanced: true, sortedHash: false, elementPrefix };

    if (oriContract) {
      this._oriContract = oriContract;
    } else {
      this._oriContract = this._web3
        ? new this._web3.eth.Contract(oriABI, oriAddress)
        : new this._ethers.Contract(oriAddress, oriABI, this._ethersSigner);
    }

    if (logicContract) {
      this._logicContract = logicContract;
    } else {
      this._logicContract = this._web3
        ? new this._web3.eth.Contract(logicABI, logicAddress)
        : new this._ethers.Contract(logicAddress, logicABI, this._ethersSigner);
    }

    // TODO: test for ethers
    this._logicContract.options.jsonInterface.forEach(({ name, type, signature, stateMutability }) => {
      if (type !== 'function') return;

      const functionSet = { normal: (args, callOptions) => this._pessimisticCall(name, args, callOptions) };

      if (stateMutability === 'pure' || stateMutability === 'view') {
        Object.assign(functionSet, {
          optimistic: (args, newState, callOptions) => this._optimisticCall(name, args, newState, callOptions),
          queue: (args, newState) => this._queueCall(name, args, newState),
        });
      }

      Object.assign(this, { [name]: functionSet });
    });

    // TODO: perhaps use web3-ethers instead of ethereum-tx-decoder
    this._optimismDecoder = optimismDecoder ?? new txDecoder.FunctionDecoder(this._oriContract.options.jsonInterface);
    this._logicDecoder = logicDecoder ?? new txDecoder.FunctionDecoder(this._logicContract.options.jsonInterface);

    this._sourceAddress = sourceAddress;

    this._state = {
      user: accountAddress,
      callDataTree: null,
      currentState: null,
      lastTime: null,
      fraudIndex: null,
    };

    this._queue = [];

    this._frauds = {};
  }

  // STATIC: Creates a new OptimisticRollIn instance, with defined parameters and options
  static fraudsterFromProof(parameters = {}, options = {}) {
    const { suspect, fraudIndex, callDataArrayHex, newStateHex, proofHex, lastTime } = parameters;

    const {
      oriContract,
      logicContract,
      sourceAddress,
      treeOptions = { elementPrefix: '00' },
      optimismDecoder,
      logicDecoder,
      web3,
      ethers,
      ethersSigner,
      parentORI,
      requiredBond,
      lockTime,
    } = options;

    const oriOptions = {
      oriContract,
      logicContract,
      sourceAddress,
      optimismDecoder,
      logicDecoder,
      treeOptions,
      web3,
      ethers,
      ethersSigner,
      parentORI,
      requiredBond,
      lockTime,
    };

    const fraudster = new OptimisticRollIn(suspect, {}, oriOptions);

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

  // GETTER: Returns the computed account state
  get accountState() {
    return hashPacked([this._state.callDataTree.root, this._state.currentState, to32ByteBuffer(this._state.lastTime)]);
  }

  // GETTER: Returns the current state of the account's data
  get currentState() {
    return this._state.currentState;
  }

  // GETTER: Returns the index of fraud, if it exists
  get fraudIndex() {
    return this._state.fraudIndex;
  }

  // GETTER: Returns if in optimistic state
  get isInOptimisticState() {
    return this._state.lastTime !== 0;
  }

  // GETTER: Returns the last optimistic time of the account
  get lastTime() {
    return this._state.lastTime;
  }

  // GETTER: Returns the current state of the account's data
  get queuedState() {
    const queueLength = this._queue.length;
    return queueLength ? this._queue[queueLength - 1].newState : this._state.currentState;
  }

  // GETTER: Returns the number of optimistic transitions of the account
  get transitionCount() {
    // TODO: this only considers on-chain transitions, but not locally queued ones
    return this._state.callDataTree.elements.length;
  }

  // GETTER: Returns if in optimistic state
  get transitionsQueued() {
    return this._queue.length;
  }

  // PRIVATE: Returns call data hex needed to call a function, given the current state and args
  _getCalldata(user, currentState, functionName, args = []) {
    // TODO: ethers path needs to be tested
    return this._web3
      ? this._logicContract.methods[functionName](toHex(user), toHex(currentState), ...args).encodeABI()
      : this._logicContract.populateTransaction[functionName](toHex(user), toHex(currentState), ...args).data;
  }

  // PRIVATE: returns the tx input args and logs
  async _getDataFromOptimisticTx(txId) {
    const data = this._web3
      ? (await this._web3.eth.getTransaction(txId)).input
      : (await this._ethersSigner.getTransaction(txId)).data;

    // TODO: perhaps use web3-ethers instead of ethereum-tx-decoder
    //       this._web3.eth.abi.decodeParameters(typesArray, hexString);
    //       this._ethers.utils.defaultAbiCoder.decode(types, data);
    const decodedData = this._optimismDecoder.decodeFn(data);

    // TODO: ethers path needs to be tested
    const { logs } = this._web3
      ? await this._web3.eth.getTransactionReceipt(txId)
      : await this._ethersSigner.getTransactionReceipt(txId);

    return { decodedData, logs };
  }

  // PRIVATE: returns if the transition results in the proposed new state
  async _isValidTransition(suspectHex, callDataHex, newStateHex, options = {}) {
    const { pureVerifiers } = options;

    // Decode sighash and use from calldata
    const decodedCallData = this._logicDecoder.decodeFn(callDataHex);
    const { sighash, user } = decodedCallData;

    // If the user extracted from the calldata does not match, its invalid
    if (!compareHex(suspectHex, user)) return false;

    try {
      // If a pure function was provided to compute this locally, then use it
      if (pureVerifiers?.[sighash]) return pureVerifiers[sighash](decodedCallData, newStateHex);

      // If not, we ned to verify against with the node, which is slower
      const callObject = { to: this._logicContract.options.address, data: callDataHex };

      // TODO: ethers path needs to be tested
      return this._web3
        ? compareHex(await this._web3.eth.call(callObject), newStateHex)
        : compareHex(await this._ethersSigner.call(callObject), newStateHex);
    } catch (err) {
      console.log(err);
      console.log(err.message);
    }

    return false;
  }

  // PRIVATE: performs an optimistic contract call, on-chain
  _optimisticCall(functionName, args, newState, options) {
    return this.isInOptimisticState
      ? this._performOptimistically(functionName, args, newState, options)
      : this._performOptimisticallyWhileEnteringOptimism(functionName, args, newState, options);
  }

  // PRIVATE: performs a non-optimistic contract call, on-chain
  async _pessimisticCall(functionName, args, callOptions) {
    if (!this.isInOptimisticState) return this._performPessimistically(functionName, args, callOptions);

    const { timestamp } = this._web3
      ? await this._web3.eth.getBlock(await this._web3.eth.getBlockNumber())
      : await this._ethersSigner.getBlock(await this._ethersSigner.getBlockNumber());

    assert(timestamp >= this._state.lastTime + this._lockTime, 'In optimistic state and cannot yet exit.');

    return this._performPessimisticallyWhileExitingOptimism(functionName, args, callOptions);
  }

  // PRIVATE: prepare calldata necessary for batch optimistic calls, within gas constraints (only for self)
  async _prepareBatchCalldata(queue = [], options = {}) {
    const { from = this._sourceAddress, gas = 1000000, estimator } = options;

    assert(compareHex(from, this._state.user), 'Can only perform on own account.');
    assert(queue.length > 1, 'Queue must contain at least 2.');

    const callDataArray = [];
    const newStatesArray = [];

    for (let i = 0; i < queue.length; i++) {
      const { functionName, args, newState } = queue[i];
      const interimState = i === 0 ? this._state.currentState : queue[i - 1].newState;
      callDataArray.push(toBuffer(this._getCalldata(this._state.user, interimState, functionName, args)));
      newStatesArray.push(newState);
    }

    const gasEstimator = (cdArray, ns) =>
      estimator(cdArray, ns, this._state.callDataTree.appendMulti(cdArray, PROOF_OPTIONS).proof);
    const index = await binarySearchGasCost(callDataArray, newStatesArray, gasEstimator, gas);

    const possibleCallDataArray = callDataArray.slice(0, index + 1);
    const newState = newStatesArray[index];

    // Get the expected new call data tree and append proof
    const { proof, newMerkleTree } = this._state.callDataTree.appendMulti(possibleCallDataArray, PROOF_OPTIONS);
    const callOptions = gas ? { from, gas } : { from };
    const remainingQueue = queue.slice(index + 1, queue.length);

    return {
      callDataArray: possibleCallDataArray,
      newState,
      proof,
      callOptions,
      newMerkleTree,
      remainingQueue,
    };
  }

  // PRIVATE: Optimistically perform batch transitions while already in optimistic state, and update internal state (only for self)
  async _performBatchOptimistically(options = {}) {
    const estimator = (callDataArray, newState, proof) =>
      this._oriContract.methods
        .perform_many_optimistically(
          toHex(callDataArray),
          toHex(newState),
          toHex(proof.root),
          toHex(proof.compactProof),
          this._state.lastTime
        )
        .estimateGas({ gas: 5000000 });

    const {
      callDataArray,
      newState,
      proof,
      callOptions,
      newMerkleTree,
      remainingQueue,
    } = await this._prepareBatchCalldata(this._queue, Object.assign({ estimator }, options));

    const receipt = await this._oriContract.methods
      .perform_many_optimistically(
        toHex(callDataArray),
        toHex(newState),
        toHex(proof.root),
        toHex(proof.compactProof),
        this._state.lastTime
      )
      .send(callOptions);

    const { returnValues } = receipt.events[EVENTS.ORI_New_Optimistic_States];
    assert(compareHex(returnValues.user, this._state.user), 'Unexpected user.');

    this._updateStateOptimistically(newMerkleTree, newState, Number(returnValues.block_time));

    this._queue.length = 0;
    this._queue = remainingQueue;

    return { newState, receipt };
  }

  // PRIVATE: Optimistically perform batch transitions to enter optimistic state, and update internal state (only for self)
  async _performBatchOptimisticallyWhileEnteringOptimism(options = {}) {
    const estimator = (callDataArray, newState, proof) =>
      this._oriContract.methods
        .perform_many_optimistically_and_enter(toHex(callDataArray), toHex(newState), toHex(proof.compactProof))
        .estimateGas({ gas: 5000000 });

    const {
      callDataArray,
      newState,
      proof,
      callOptions,
      newMerkleTree,
      remainingQueue,
    } = await this._prepareBatchCalldata(this._queue, Object.assign({ estimator }, options));

    const receipt = await this._oriContract.methods
      .perform_many_optimistically_and_enter(toHex(callDataArray), toHex(newState), toHex(proof.compactProof))
      .send(callOptions);

    const { returnValues } = receipt.events[EVENTS.ORI_New_Optimistic_States];
    assert(compareHex(returnValues.user, this._state.user), 'Unexpected user.');

    this._updateStateOptimistically(newMerkleTree, newState, Number(returnValues.block_time));

    this._queue.length = 0;
    this._queue = remainingQueue;

    return { newState, receipt };
  }

  // PRIVATE: Optimistically perform a transition while already in optimistic state, and update internal state (only for self)
  async _performOptimistically(functionName, args = [], newState, options = {}) {
    const { from = this._sourceAddress, gas } = options;

    assert(compareHex(from, this._state.user), 'Can only perform on own account.');

    const callDataHex = await this._getCalldata(this._state.user, this._state.currentState, functionName, args);

    // Get the expected new call data tree and append proof
    const { proof, newMerkleTree } = this._state.callDataTree.appendSingle(toBuffer(callDataHex), PROOF_OPTIONS);

    const callOptions = { from };

    if (gas) {
      callOptions.gas = gas;
    }

    const receipt = await this._oriContract.methods
      .perform_optimistically(
        callDataHex,
        toHex(newState),
        toHex(proof.root),
        toHex(proof.compactProof),
        this._state.lastTime
      )
      .send(callOptions);

    const { returnValues } = receipt.events[EVENTS.ORI_New_Optimistic_State];
    assert(compareHex(returnValues.user, this._state.user), 'Unexpected user.');

    this._updateStateOptimistically(newMerkleTree, newState, Number(returnValues.block_time));

    return { newState, receipt };
  }

  // PRIVATE: Optimistically perform a transition to enter optimistic state, and update internal state (only for self)
  async _performOptimisticallyWhileEnteringOptimism(functionName, args = [], newState, options = {}) {
    const { from = this._sourceAddress, gas } = options;

    assert(compareHex(from, this._state.user), 'Can only perform on own account.');

    const callDataHex = await this._getCalldata(this._state.user, this._state.currentState, functionName, args);

    // Get the expected new call data tree and append proof
    const { proof, newMerkleTree } = this._state.callDataTree.appendSingle(toBuffer(callDataHex), PROOF_OPTIONS);

    const callOptions = { from };

    if (gas) {
      callOptions.gas = gas;
    }

    const receipt = await this._oriContract.methods
      .perform_optimistically_and_enter(callDataHex, toHex(newState), toHex(proof.compactProof))
      .send(callOptions);

    const { returnValues } = receipt.events[EVENTS.ORI_New_Optimistic_State];
    assert(compareHex(returnValues.user, this._state.user), 'Unexpected user.');

    this._updateStateOptimistically(newMerkleTree, newState, Number(returnValues.block_time));

    return { newState, receipt };
  }

  // PRIVATE: Non-optimistically perform a transition, and update internal state (only for self)
  async _performPessimistically(functionName, args = [], options = {}) {
    const { from = this._sourceAddress, gas } = options;

    assert(compareHex(from, this._state.user), 'Can only perform on own account.');

    const callDataHex = this._getCalldata(this._state.user, this._state.currentState, functionName, args);

    const callOptions = { from };

    if (gas) {
      callOptions.gas = gas;
    }

    const receipt = await this._oriContract.methods.perform(callDataHex).send(callOptions);

    const { returnValues } = receipt.events[EVENTS.ORI_New_State];
    assert(compareHex(returnValues.user, this._state.user), 'Unexpected user.');

    this._updateStatePessimistically(toBuffer(returnValues.new_state));

    return { newState: returnValues.new_state, receipt };
  }

  // PRIVATE: Non-optimistically perform a transition to exit optimistic state, and update internal state (only for self)
  async _performPessimisticallyWhileExitingOptimism(functionName, args = [], options = {}) {
    const { from = this._sourceAddress, gas } = options;

    assert(compareHex(from, this._state.user), 'Can only perform on own account.');

    const callDataHex = await this._getCalldata(this._state.user, this._state.currentState, functionName, args);

    const callOptions = { from };

    if (gas) {
      callOptions.gas = gas;
    }

    const receipt = await this._oriContract.methods
      .perform_and_exit(callDataHex, toHex(this._state.callDataTree.root), this._state.lastTime)
      .send(callOptions);

    const { returnValues } = receipt.events[EVENTS.ORI_New_State];
    assert(compareHex(returnValues.user, this._state.user), 'Unexpected user.');

    this._updateStatePessimistically(toBuffer(returnValues.new_state));

    return { newState: returnValues.new_state, receipt };
  }

  // PRIVATE: queues a transition to be broadcasted in batch later
  _queueCall(functionName, args = [], newState) {
    // TODO: assert that args.currentState is newState
    this._queue.push({ functionName, args, newState });
  }

  // PRIVATE: Creates and stores an ORI instance by cloning current instance, and setting account to fraudulent user's data
  _recordFraud(parameters) {
    const { suspect } = parameters;

    const options = {
      oriContract: this._oriContract,
      logicContract: this._logicContract,
      sourceAddress: this._sourceAddress,
      treeOptions: this._treeOptions,
      optimismDecoder: this._optimismDecoder,
      logicDecoder: this._logicDecoder,
      web3: this._web3,
      ethers: this._ethers,
      ethersSigner: this._ethersSigner,
      parentORI: this,
      requiredBond: this._requiredBond,
      lockTime: this._lockTime,
    };

    this._frauds[suspect] = OptimisticRollIn.fraudsterFromProof(parameters, options);
  }

  // PRIVATE: Updates the state with new call data tree, new state, and last optimistic time
  _updateStateOptimistically(newMerkleTree, newState, lastTime) {
    this._state.callDataTree = newMerkleTree;
    this._state.currentState = newState;
    this._state.lastTime = lastTime;
  }

  // PRIVATE: Updates the state with empty call data tree, computed new state, and 0 last optimistic time
  _updateStatePessimistically(newState) {
    this._state.callDataTree = new MerkleTree([], this._treeOptions);
    this._state.currentState = newState;
    this._state.lastTime = 0;
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

  // PRIVATE: Verifies batch optimistic transitions, and creates a fraudster ORI if fraud is found
  async _verifyBatchTransitions(suspectHex, decodedOptimismData, lastTime, options) {
    // Decode the optimism input data
    const { call_data: callDataArrayHex, new_state: newStateHex, proof: proofHex } = decodedOptimismData;

    // Compute what the new states should have been, from the original state
    for (let i = 0; i < callDataArrayHex.length; i++) {
      const intermediateStateHex =
        i === callDataArrayHex.length - 1
          ? newStateHex
          : this._logicDecoder.decodeFn(callDataArrayHex[i + 1]).current_state;

      if (await this._isValidTransition(suspectHex, callDataArrayHex[i], intermediateStateHex, options)) continue;

      this._recordFraud({
        suspect: suspectHex,
        fraudIndex: i,
        callDataArrayHex,
        newStateHex,
        proofHex,
        lastTime,
      });

      return { valid: false, user: suspectHex };
    }

    return { valid: true, user: suspectHex };
  }

  // PRIVATE: Verifies an optimistic transition, and creates a fraudster ORI if fraud is found
  async _verifyTransition(suspectHex, decodedOptimismData, lastTime, options) {
    // Decode the optimism input data
    const { call_data: callDataHex, new_state: newStateHex, proof: proofHex } = decodedOptimismData;

    if (await this._isValidTransition(suspectHex, callDataHex, newStateHex, options)) {
      return { valid: true, user: suspectHex };
    }

    this._recordFraud({
      suspect: suspectHex,
      fraudIndex: 0,
      callDataArrayHex: [callDataHex],
      newStateHex,
      proofHex,
      lastTime,
    });

    return { valid: false, user: suspectHex };
  }

  // PUBLIC: Bonds the user's account, using the source address (which may be the same as the user)
  async bond() {
    const amountRequired = this._requiredBond - (await this.getBalance());
    assert(amountRequired > 0n, 'Bond not required.');

    const callOptions = { value: amountRequired.toString(), from: this._sourceAddress };
    const receipt = await this._oriContract.methods.bond(this._state.user).send(callOptions);

    return { receipt };
  }

  // PUBLIC: Clear the queued transitions
  clearQueue() {
    this._queue.length = 0;
  }

  // PUBLIC: Delete internal fraudster object
  deleteFraudster(user) {
    this._frauds[user] = null;
  }

  // PUBLIC: Returns the account user's balance (on chain)
  async getAccountState(user = this._state.user) {
    const accountState = await this._oriContract.methods.account_states(user).call();

    return accountState === ZERO_BYTES_32 ? null : toBuffer(accountState);
  }

  // PUBLIC: Returns true if the account is initialized (on chain)
  async isInitialized(user = this._state.user) {
    return !!(await this.getAccountState(user));
  }

  // PUBLIC: Returns the account user's balance (on chain)
  async getBalance(user = this._state.user) {
    const balance = await this._oriContract.methods.balances(user).call();

    return BigInt(balance.toString());
  }

  // PUBLIC: Returns true if the account is sufficiently bonded (on chain)
  async isBonded(user = this._state.user) {
    return (await this.getBalance(user)) >= this._requiredBond;
  }

  // PUBLIC: Returns an ORI instance (if exists) for a fraudulent user's address
  getFraudster(user) {
    return this._frauds[user.toLowerCase()];
  }

  // PUBLIC: Returns the locked of this account, if any (on chain)
  async getLocker(user = this._state.user) {
    const locker = await this._oriContract.methods.lockers(user).call();

    return compareHex(locker, ZERO_ADDRESS) ? null : locker;
  }

  // PUBLIC: Returns lock time for the account (on chain)
  async getLockTimestamp(user = this._state.user) {
    const lockTimestamp = await this._oriContract.methods.locked_timestamps(user).call();

    return Number(lockTimestamp);
  }

  // PUBLIC: Returns the rollback size that the account needs to be rolled back to (on chain)
  async getRollbackSize(user = this._state.user) {
    const rollbackSize = await this._oriContract.methods.rollback_sizes(user).call();

    return Number(rollbackSize);
  }

  // PUBLIC: Returns approximate time remaining until account can exit optimism (on chain)
  async getLockTimeRemaining(user = this._state.user) {
    const { timestamp } = this._web3
      ? await this._web3.eth.getBlock(await this._web3.eth.getBlockNumber())
      : await this._ethersSigner.getBlock(await this._ethersSigner.getBlockNumber());

    const timeRemaining = timestamp - ((await this.getLockTimestamp(user)) + this._lockTime);

    return timeRemaining > 0 ? timeRemaining : 0;
  }

  // PUBLIC: Initialize the on-chain account and the internal state (only for self)
  async initialize(options = {}) {
    const { deposit = '0', from = this._sourceAddress, gas } = options;

    assert(compareHex(from, this._state.user), 'Can only initialize own account.');
    assert(!(await this.getAccountState()), 'Already Initialized.');

    const amountRequired = this._requiredBond - (await this.getBalance());
    const additionalBond = amountRequired > 0n ? amountRequired : 0n;
    const value = (BigInt(deposit) + additionalBond).toString();

    const callOptions = { from, value };

    if (gas) {
      callOptions.gas = gas;
    }

    const receipt = await this._oriContract.methods.initialize().send(callOptions);

    assert(receipt.events[EVENTS.ORI_New_State].returnValues.user === this._state.user, 'Unexpected user.');

    const newState = receipt.events[EVENTS.ORI_New_State].returnValues.new_state;
    this._updateStatePessimistically(toBuffer(newState));

    return { newState, receipt };
  }

  // PUBLIC: Returns whether the account is in an optimistic state (on chain)
  async checkIsInOptimisticState(user = this._state.user, currentState = this._state.currentState) {
    const accountState = await this.getAccountState(user);

    if (!accountState) false;

    return hashPacked([to32ByteBuffer(0), currentState, to32ByteBuffer(0)]).equals(accountState);
  }

  // PUBLIC: Locks user's account, from the source address (which may be the same as the user)
  async lock(options = {}) {
    const { from = this._sourceAddress, gas } = options;

    assert(!(await this.getLocker()), 'Account already locked.');

    const amountRequired = this._requiredBond - (await this.getBalance(from));
    const value = amountRequired > 0n ? amountRequired.toString() : '0';
    const callOptions = { from, value, gas: gas ?? 140000 };
    const receipt = await this._oriContract.methods.lock(this._state.user).send(callOptions);

    const { returnValues } = receipt.events[EVENTS.ORI_Locked];
    assert(compareHex(returnValues.accuser, this._sourceAddress), 'Unexpected accuser.');
    assert(compareHex(returnValues.suspect, this._state.user), 'Unexpected suspect.');

    return { receipt };
  }

  // PUBLIC: Submit proof to ORI contract that account user committed fraud
  async proveFraud(options = {}) {
    const { from = this._sourceAddress, gas } = options;

    // Build a Multi Proof for the call data of the fraudulent transition
    const indices = [this._state.fraudIndex, this._state.fraudIndex + 1];
    const { root, elements, compactProof } = this._state.callDataTree.generateMultiProof(indices, PROOF_OPTIONS);

    const callOptions = { from };

    if (gas) {
      callOptions.gas = gas;
    }

    // Prove the fraud
    const receipt = await this._oriContract.methods
      .prove_fraud(
        this._state.user,
        toHex(elements),
        toHex(this._state.currentState),
        toHex(root),
        toHex(compactProof),
        this._state.lastTime
      )
      .send(callOptions);

    const { returnValues } = receipt.events[EVENTS.ORI_Fraud_Proven];
    assert(compareHex(returnValues.accuser, this._sourceAddress), 'Unexpected accuser.');
    assert(compareHex(returnValues.suspect, this._state.user), 'Unexpected suspect.');
    assert(Number(returnValues.transition_index) === this._state.fraudIndex, 'Unexpected index.');

    // TODO: This is just a hack to prevent re-proving fraud after the first success
    this._state.fraudIndex = null;

    if (this._parentORI) {
      this._parentORI.deleteFraudster(this._state.user);
    }

    return { receipt };
  }

  // PUBLIC: Rollback optimistic state (and thus calldata tree) to right before the fraud index
  async rollback(options = {}) {
    const { from = this._sourceAddress, gas } = options;

    assert(compareHex(from, this._state.user), 'Can only rollback own account.');

    const index = await this.getRollbackSize();
    assert(index < this.transitionCount, 'Unexpected rollback index.');

    const amountRequired = this._requiredBond - (await this.getBalance());
    const value = amountRequired > 0n ? amountRequired.toString() : '0';

    // Need to create a call data Merkle Tree of all pre-invalid-transition call data
    // Note: rollbackSize is a bad name. Its really the expected size of the tree after the rollback is performed
    const oldCallData = this._state.callDataTree.elements.slice(0, index);
    const oldCallDataTree = new MerkleTree(oldCallData, this._treeOptions);
    const rolledBackCallDataArray = this._state.callDataTree.elements.slice(index);

    // Need to build an Append Proof to prove that the old call data root, when appended with the rolled back call data,
    // has the root that equals the root of current on-chain call data tree
    const { proof } = oldCallDataTree.appendMulti(rolledBackCallDataArray, PROOF_OPTIONS);
    const { root: oldRoot, compactProof: appendProof } = proof;

    // User needs to prove to the current size of the on-chain call data tree
    const { root, elementCount, elementRoot: sizeProof } = this._state.callDataTree.generateSizeProof(PROOF_OPTIONS);

    const callOptions = { from, value };

    if (gas) {
      callOptions.gas = gas;
    }

    // User performs the rollback while bonding new coin at the same time
    const receipt = await this._oriContract.methods
      .rollback(
        toHex(oldRoot),
        toHex(rolledBackCallDataArray),
        toHex(appendProof),
        elementCount,
        toHex(sizeProof),
        toHex(root),
        toHex(this._state.currentState),
        this._state.lastTime
      )
      .send(callOptions);

    const { returnValues } = receipt.events[EVENTS.ORI_Rolled_Back];
    assert(compareHex(returnValues.user, this._state.user), 'Unexpected user.');
    assert(returnValues.tree_size.toString() === index.toString(), 'Unexpected tree size.');

    const currentState = rolledBackCallDataArray[0].slice(36, 68);
    this._updateStateOptimistically(oldCallDataTree, currentState, Number(returnValues.block_time));

    // TODO: this is weird, because this isn't here for the suspect's own ori instance
    this._state.fraudIndex = null;

    return { newState: currentState, receipt };
  }

  // PUBLIC: Rolls the entire transition queue into a single transaction and broadcasts (only for self)
  async sendQueue(options = {}) {
    // if in optimism, perform optimistically, else, perform and enter
    const result = this.isInOptimisticState
      ? await this._performBatchOptimistically(options)
      : await this._performBatchOptimisticallyWhileEnteringOptimism(options);

    return result;
  }

  // PUBLIC: Unbonds the user's account to some destination
  async unbond(destination, options = {}) {
    const { from = this._sourceAddress, gas } = options;

    const callOptions = { from };

    if (gas) {
      callOptions.gas = gas;
    }

    const receipt = await this._oriContract.methods.unbond(destination).send(callOptions);

    return { receipt };
  }

  // PUBLIC: Updates the internal state given an optimistic tx
  async update(txId) {
    const { decodedData, logs } = await this._getDataFromOptimisticTx(txId);
    const { sighash } = decodedData;

    const oriLog = logs.find(({ topics }) =>
      [TOPICS.ORI_New_Optimistic_State, TOPICS.ORI_New_Optimistic_States].includes(topics[0])
    );

    // TODO: should also not update unless its a fraudster (partial merkle tree)
    assert(compareHex(prefix(oriLog.topics[1].slice(26)), this._state.user), 'User mismatch.');

    const lastTime = parseInt(oriLog.topics[2].slice(2), 16);

    if ([SIG_HASHES.PerformManyOptimisticallyAndEnter, SIG_HASHES.PerformManyOptimistically].includes(sighash)) {
      return this._updateWithBatchTransitions(decodedData, lastTime);
    }

    if ([SIG_HASHES.PerformOptimisticallyAndEnter, SIG_HASHES.PerformOptimistically].includes(sighash)) {
      return this._updateWithTransition(decodedData, lastTime);
    }
  }

  // PUBLIC: Unlock account, from the source address (which may be the same as the user)
  async unlock(options = {}) {
    const { from = this._sourceAddress, gas } = options;

    assert(await this.getLocker(), 'Account already unlocked.');

    const callOptions = { from, value, gas: gas ?? 100000 };
    const receipt = await this._oriContract.methods
      .unlock(
        this._state.user,
        toHex(this._state.currentState),
        toHex(this._state.callDataTree.root),
        this._state.lastTime
      )
      .send(callOptions);

    const { returnValues } = receipt.events[EVENTS.ORI_Unlocked];
    assert(compareHex(returnValues.suspect, this._state.user), 'Unexpected suspect.');

    this._state.lastTime = Number(returnValues.block_time);

    return { receipt };
  }

  // PUBLIC: Verifies the transitions(s) of an optimistic tx, and creates a fraudster ORI if fraud is found
  async verifyTransaction(txId, options) {
    const { decodedData, logs } = await this._getDataFromOptimisticTx(txId);
    const { sighash } = decodedData;

    const oriLog = logs.find(({ topics }) =>
      [TOPICS.ORI_New_Optimistic_State, TOPICS.ORI_New_Optimistic_States].includes(topics[0])
    );

    const suspectHex = prefix(oriLog.topics[1].slice(26));
    const lastTime = parseInt(oriLog.topics[2].slice(2), 16);

    return [SIG_HASHES.PerformManyOptimisticallyAndEnter, SIG_HASHES.PerformManyOptimistically].includes(sighash)
      ? await this._verifyBatchTransitions(suspectHex, decodedData, lastTime, options)
      : [SIG_HASHES.PerformOptimisticallyAndEnter, SIG_HASHES.PerformOptimistically]
      ? await this._verifyTransition(suspectHex, decodedData, lastTime, options)
      : { valid: true };
  }
}

module.exports = OptimisticRollIn;
