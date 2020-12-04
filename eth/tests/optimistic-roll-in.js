const chai = require('chai');
const { expect } = chai;
const crypto = require('crypto');

const OptimisticRollInArtifact = artifacts.require('Optimistic_Roll_In');
const SomeLogicContractArtifact = artifacts.require('Some_Logic_Contract');

const OptimisticRollIn = require('../../js/src');
const { to32ByteBuffer, hashPacked, toHex, toBuffer } = require('../../js/src/utils');

// TODO: test DOS lock and unlock

const somePureTransition = (_user, _currentState, _arg) => {
  const user = toBuffer(_user);
  const currentState = toBuffer(_currentState);
  const arg = toBuffer(_arg);

  let newState = hashPacked([currentState, user]);

  for (let i = 0; i < 1000; i++) {
    newState = hashPacked([newState, arg]);
  }

  return newState;
};

const somPureTransitionVerifier = (decodedCallData, newStateHex) => {
  const { user, current_state: currentStateHex, some_arg: somArgHex } = decodedCallData;

  return toHex(somePureTransition(user, currentStateHex, somArgHex)) === newStateHex;
};

const pureVerifiers = {
  '0xef6f6a42': somPureTransitionVerifier,
};

const someFraudTransition = (_user, _currentState, _argHex) => {
  return to32ByteBuffer(1337);
};

const generateRandomElement = () => {
  return crypto.randomBytes(32);
};

const generateElements = (elementCount, options = {}) => {
  const { seed, random = false } = options;
  const elements = [];
  let seedBuffer = seed ? Buffer.from(seed, 'hex') : null;
  let element = seedBuffer;

  for (let i = 0; i < elementCount; i++) {
    element = random ? generateRandomElement() : seed ? hashPacked([seedBuffer, element]) : to32ByteBuffer(i);
    seedBuffer = seed ? element : seedBuffer;
    elements.push(element);
  }

  return elements;
};

const advanceTime = (time) => {
  return new Promise((resolve, reject) => {
    web3.currentProvider.send(
      {
        jsonrpc: '2.0',
        method: 'evm_increaseTime',
        params: [time],
        id: new Date().getTime(),
      },
      (err, result) => {
        if (err) return reject(err);

        return resolve(result);
      }
    );
  });
};

const advanceBlock = () => {
  return new Promise((resolve, reject) => {
    web3.currentProvider.send(
      {
        jsonrpc: '2.0',
        method: 'evm_mine',
        id: new Date().getTime(),
      },
      (err, result) => {
        if (err) return reject(err);

        return resolve(result);
      }
    );
  });
};

const someDelay = (seconds) => {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
};

contract('Optimistic Roll In', (accounts) => {
  describe('Basic Testing (must be performed in order)', async () => {
    let requiredBond = null;
    let lockTime = null;
    let logicContractInstance = null;
    let logicAddress = null;
    let optimismContractInstance = null;
    let optimismAddress = null;
    let fraudulentTransitionIndex = null;

    let suspect = accounts[0];
    let suspectOptimist = null;
    let suspectBondAmount = '0';
    let suspectLastTxId = null;
    let suspectDepositAmount = '0';

    let accuser = accounts[1];
    let accuserOptimist = null;
    let accuserBondAmount = '0';

    before(async () => {
      logicContractInstance = await SomeLogicContractArtifact.deployed();
      logicAddress = logicContractInstance.address;
      optimismContractInstance = await OptimisticRollInArtifact.deployed();
      optimismAddress = optimismContractInstance.address;

      const contracts = {
        oriAddress: optimismAddress,
        oriABI: optimismContractInstance.abi,
        logicAddress,
        logicABI: logicContractInstance.abi,
      };

      const network = await web3.eth.net.getId();
      requiredBond = network === 5777 ? '1000000000000000000' : '10000000000000';
      lockTime = network === 5777 ? '600' : '60';
      const oriOptions = { treeOptions: { elementPrefix: '00' }, web3, requiredBond, lockTime };

      suspectOptimist = new OptimisticRollIn(suspect, contracts, oriOptions);

      accuserOptimist = new OptimisticRollIn(accuser, contracts, oriOptions);
    });

    it('[ 1] can bond a user (who will eventually be the guilty suspect).', async () => {
      const { receipt } = await suspectOptimist.bond();
      suspectBondAmount = requiredBond;

      const bondBalance = await suspectOptimist.getBalance();
      const optimismBalance = await web3.eth.getBalance(optimismAddress);

      expect(bondBalance.toString()).to.equal(suspectBondAmount);
      expect(optimismBalance.toString()).to.equal(suspectBondAmount);

      if (receipt.gasUsed !== 42844) {
        console.log(`Not Critical, but we expected gas used for [ 1] to be 42844, but got ${receipt.gasUsed}`);
      }
    });

    it('[ 2] can initialize a user (suspect) and deposit some ETH in the logic contract.', async () => {
      suspectDepositAmount = '500000000000000000';
      const options = { deposit: suspectDepositAmount, gas: 60000 };
      const { receipt } = await suspectOptimist.initialize(options);
      const accountState = await suspectOptimist.getAccountState();
      const bondBalance = await suspectOptimist.getBalance();
      const logicBalance = await web3.eth.getBalance(logicAddress);
      const optimismBalance = await web3.eth.getBalance(optimismAddress);

      expect(accountState.equals(suspectOptimist.accountState)).to.be.true;
      expect(bondBalance.toString()).to.equal(suspectBondAmount);
      expect(logicBalance.toString()).to.equal(suspectDepositAmount);
      expect(optimismBalance.toString()).to.equal(suspectBondAmount);

      if (receipt.gasUsed !== 53942) {
        console.log(`Not Critical, but we expected gas used for [ 2] to be 53942, but got ${receipt.gasUsed}`);
      }
    });

    it('[ 3] allows a user (suspect) to perform a normal state transition (and remain outside of optimism).', async () => {
      const someArg = generateElements(1, { seed: '11' })[0];

      const callArgs = [toHex(someArg)];
      const callOptions = { gas: 60000 };
      const { receipt } = await suspectOptimist.some_impure_transition.normal(callArgs, callOptions);
      const accountState = await suspectOptimist.getAccountState();

      expect(accountState.equals(suspectOptimist.accountState)).to.be.true;

      if (receipt.gasUsed !== 38054) {
        console.log(`Not Critical, but we expected gas used for [ 3] to be 38054, but got ${receipt.gasUsed}`);
      }
    });

    it('[ 4] allows a user (suspect) to perform a valid optimistic state transition (and enter optimism).', async () => {
      const someArg = generateElements(1, { seed: '22' })[0];

      const callArgs = [toHex(someArg)];
      const newState = somePureTransition(suspect, suspectOptimist.currentState, someArg);
      const callOptions = { gas: 40000 };
      const { receipt } = await suspectOptimist.some_pure_transition.optimistic(callArgs, newState, callOptions);
      suspectLastTxId = receipt.transactionHash;

      const accountState = await suspectOptimist.getAccountState();

      expect(accountState.equals(suspectOptimist.accountState)).to.be.true;

      if (receipt.gasUsed !== 34351) {
        console.log(`Not Critical, but we expected gas used for [ 4] to be 34351, but got ${receipt.gasUsed}`);
      }
    });

    it('[ 5] allows a user (accuser) to immediately verify a valid optimistic state transition (using the node).', async () => {
      const { valid, user } = await accuserOptimist.verifyTransaction(suspectLastTxId);

      expect(valid).to.be.true;
      expect(user).to.equal(suspect.toLowerCase());
    });

    it('[ 6] allows a user (suspect) to perform a valid optimistic state transition.', async () => {
      const someArg = generateElements(1, { seed: '33' })[0];

      const callArgs = [toHex(someArg)];
      const newState = somePureTransition(suspect, suspectOptimist.currentState, someArg);
      const callOptions = { gas: 40000 };
      const { receipt } = await suspectOptimist.some_pure_transition.optimistic(callArgs, newState, callOptions);
      suspectLastTxId = receipt.transactionHash;

      const accountState = await suspectOptimist.getAccountState();

      expect(accountState.equals(suspectOptimist.accountState)).to.be.true;

      if (receipt.gasUsed !== 36225) {
        console.log(`Not Critical, but we expected gas used for [ 6] to be 36225, but got ${receipt.gasUsed}`);
      }
    });

    it('[ 7] allows a user (accuser) to immediately verify a valid optimistic state transition (using local js).', async () => {
      const { valid, user } = await accuserOptimist.verifyTransaction(suspectLastTxId, { pureVerifiers });

      expect(valid).to.be.true;
      expect(user).to.equal(suspect.toLowerCase());
    });

    it('[ 8] allows a user (suspect) to perform valid optimistic state transitions in batch.', async () => {
      const calls = 100;
      const someArgs = generateElements(calls, { seed: '44' });

      for (let i = 0; i < calls; i++) {
        const callArgs = [toHex(someArgs[i])];
        const newState = somePureTransition(suspect, suspectOptimist.queuedState, someArgs[i]);
        suspectOptimist.some_pure_transition.queue(callArgs, newState);
      }

      expect(suspectOptimist.transitionsQueued).to.equal(calls);

      const callOptions = { gas: 340000 };
      const { receipt } = await suspectOptimist.sendQueue(callOptions);
      suspectLastTxId = receipt.transactionHash;

      const accountState = await suspectOptimist.getAccountState();

      expect(suspectOptimist.transitionsQueued).to.equal(0);
      expect(accountState.equals(suspectOptimist.accountState)).to.be.true;

      if (receipt.gasUsed !== 323982) {
        console.log(`Not Critical, but we expected gas used for [ 8] to be 323982, but got ${receipt.gasUsed}`);
      }
    });

    it('[ 9] allows a user (accuser) to immediately verify valid batched optimistic state transitions (using local js).', async () => {
      const { valid, user } = await accuserOptimist.verifyTransaction(suspectLastTxId, { pureVerifiers });

      expect(valid).to.be.true;
      expect(user).to.equal(suspect.toLowerCase());
    });

    it('[10] allows a user (suspect) to perform fraudulent optimistic state transitions in batch.', async () => {
      const fraudulentIndex = 20;
      fraudulentTransitionIndex = suspectOptimist.transitionCount + fraudulentIndex;

      const calls = 100;
      const someArgs = generateElements(calls, { seed: '55' });

      for (let i = 0; i < calls; i++) {
        const callArgs = [toHex(someArgs[i])];

        const newState =
          i === fraudulentIndex
            ? someFraudTransition(suspect, suspectOptimist.queuedState, someArgs[i])
            : somePureTransition(suspect, suspectOptimist.queuedState, someArgs[i]);

        suspectOptimist.some_pure_transition.queue(callArgs, newState);
      }

      expect(suspectOptimist.transitionsQueued).to.equal(calls);

      const callOptions = { gas: 340000 };
      const { receipt } = await suspectOptimist.sendQueue(callOptions);
      suspectLastTxId = receipt.transactionHash;

      const accountState = await suspectOptimist.getAccountState();

      expect(suspectOptimist.transitionsQueued).to.equal(0);
      expect(accountState.equals(suspectOptimist.accountState)).to.be.true;

      if (receipt.gasUsed !== 327193) {
        console.log(`Not Critical, but we expected gas used for [ 10] to be 327193, but got ${receipt.gasUsed}`);
      }
    });

    it('[11] allows a user (accuser) to immediately detect a transaction containing a fraudulent state transition (using local js).', async () => {
      const { valid, user } = await accuserOptimist.verifyTransaction(suspectLastTxId, { pureVerifiers });

      expect(valid).to.be.false;
      expect(user).to.equal(suspect.toLowerCase());

      const fraudster = accuserOptimist.getFraudster(suspect);
      const accountState = await suspectOptimist.getAccountState();

      expect(fraudster.fraudIndex).to.equal(fraudulentTransitionIndex);
      expect(accountState.equals(suspectOptimist.accountState)).to.be.true;
    });

    it('[12] allows a user (suspect) to perform a valid optimistic state transition on top of an invalid state.', async () => {
      const someArg = generateElements(1, { seed: '66' })[0];

      const callArgs = [toHex(someArg)];
      const newState = somePureTransition(suspect, suspectOptimist.currentState, someArg);
      const callOptions = { gas: 40000 };
      const { receipt } = await suspectOptimist.some_pure_transition.optimistic(callArgs, newState, callOptions);
      suspectLastTxId = receipt.transactionHash;

      const accountState = await suspectOptimist.getAccountState();

      expect(accountState.equals(suspectOptimist.accountState)).to.be.true;

      if (receipt.gasUsed !== 38694) {
        console.log(`Not Critical, but we expected gas used for [ 12] to be 38694, but got ${receipt.gasUsed}`);
      }
    });

    it("[13] allows a user (accuser) to update their local partial tree with the suspect's pre-lockout valid transition.", async () => {
      const fraudster = accuserOptimist.getFraudster(suspect);

      await fraudster.update(suspectLastTxId);
      const accountState = await suspectOptimist.getAccountState();

      expect(accountState.equals(fraudster.accountState)).to.be.true;
    });

    it('[14] allows a user (suspect) to perform valid optimistic state transitions in batch on top of an invalid state.', async () => {
      const calls = 20;
      const someArgs = generateElements(calls, { seed: '77' });

      for (let i = 0; i < calls; i++) {
        const callArgs = [toHex(someArgs[i])];
        const newState = somePureTransition(suspect, suspectOptimist.queuedState, someArgs[i]);
        suspectOptimist.some_pure_transition.queue(callArgs, newState);
      }

      expect(suspectOptimist.transitionsQueued).to.equal(calls);

      const callOptions = { gas: 120000 };
      const { receipt } = await suspectOptimist.sendQueue(callOptions);
      suspectLastTxId = receipt.transactionHash;

      const accountState = await suspectOptimist.getAccountState();

      expect(suspectOptimist.transitionsQueued).to.equal(0);
      expect(accountState.equals(suspectOptimist.accountState)).to.be.true;

      if (receipt.gasUsed !== 98016) {
        console.log(`Not Critical, but we expected gas used for [ 14] to be 98016, but got ${receipt.gasUsed}`);
      }
    });

    it("[15] allows a user (accuser) to lock a suspect's account for a time frame.", async () => {
      // An accuser, who previously detected the fraudulent transition will, will lock out the suspect (and bond themselves at the same time)
      const fraudster = accuserOptimist.getFraudster(suspect);

      const callOptions = { gas: 140000 };
      const { receipt } = await fraudster.lock(callOptions);
      accuserBondAmount = requiredBond;

      const block = await web3.eth.getBlock(receipt.blockNumber);
      const suspectLocker = await fraudster.getLocker();
      const suspectLockedTime = await fraudster.getLockTimestamp();
      const accuserBondBalance = await accuserOptimist.getBalance();
      const accuserLocker = await accuserOptimist.getLocker();
      const accuserLockedTime = await accuserOptimist.getLockTimestamp();

      expect(accuserBondBalance.toString()).to.equal(accuserBondAmount);

      expect(suspectLocker).to.equal(accuser);
      expect(suspectLockedTime.toString()).to.equal(block.timestamp.toString());
      expect(accuserLocker).to.equal(accuser);
      expect(accuserLockedTime.toString()).to.equal(block.timestamp.toString());

      if (receipt.gasUsed !== 128150) {
        console.log(`Not Critical, but we expected gas used for [ 15] to be 128150, but got ${receipt.gasUsed}`);
      }
    });

    it("[16] allows a user (accuser) to update their local partial tree with the suspect's pre-lockout valid transition.", async () => {
      const fraudster = accuserOptimist.getFraudster(suspect);

      await fraudster.update(suspectLastTxId);
      const accountState = await suspectOptimist.getAccountState();

      expect(accountState.equals(fraudster.accountState)).to.be.true;
    });

    it("[17] allows a user (accuser) to prove a suspect's fraud (from a partial tree).", async () => {
      const fraudster = accuserOptimist.getFraudster(suspect);

      const callOptions = { gas: 400000 };
      const { receipt } = await fraudster.proveFraud(callOptions);

      expect(accuserOptimist.getFraudster(suspect)).to.equal(null);

      const suspectBalance = await fraudster.getBalance();
      const suspectLocker = await fraudster.getLocker();
      const suspectLockedTime = await fraudster.getLockTimestamp();
      const suspectRollbackSize = await fraudster.getRollbackSize();

      const accuserBalance = await accuserOptimist.getBalance();
      const accuserLocker = await accuserOptimist.getLocker();
      const accuserLockedTime = await accuserOptimist.getLockTimestamp();

      const expectedAccuserBalance = web3.utils
        .toBN(suspectBondAmount)
        .add(web3.utils.toBN(accuserBondAmount))
        .toString();

      suspectBondAmount = '0';

      expect(suspectBalance.toString()).to.equal('0');
      expect(suspectLocker).to.equal(suspect);
      expect(suspectLockedTime).to.equal(0);
      expect(suspectRollbackSize).to.equal(fraudulentTransitionIndex);

      expect(accuserBalance.toString()).to.equal(expectedAccuserBalance);
      expect(accuserLocker).to.equal(null);
      expect(accuserLockedTime).to.equal(0);

      if (receipt.gasUsed !== 302409) {
        console.log(`Not Critical, but we expected gas used for [ 17] to be 302409, but got ${receipt.gasUsed}`);
      }
    });

    it('[18] allows a user (accuser) to unbond their balance (including the reward).', async () => {
      const startingEth = BigInt(await web3.eth.getBalance(accuser));

      const callOptions = { gas: 40000 };
      const { receipt } = await accuserOptimist.unbond(accuser, callOptions);
      accuserBondAmount = '0';

      const endingEth = BigInt(await web3.eth.getBalance(accuser));

      const accuserBalance = await accuserOptimist.getBalance();
      const suspectBalance = await suspectOptimist.getBalance();
      const optimismBalance = await web3.eth.getBalance(optimismAddress);

      // I guess negative here for public since bond/reward is cheaper than proof cost
      const expectedBalance = (await web3.eth.net.getId()) === 5777 ? '1999957846000000000' : '-1078000000000';

      expect((endingEth - startingEth).toString()).to.equal(expectedBalance);
      expect(accuserBalance.toString()).to.equal('0');
      expect(suspectBalance.toString()).to.equal('0');
      expect(optimismBalance.toString()).to.equal('0');

      if (receipt.gasUsed !== 21077) {
        console.log(`Not Critical, but we expected gas used for [ 18] to be 21077, but got ${receipt.gasUsed}`);
      }
    });

    it('[19] allows a user (suspect) to rollback their call data tree.', async () => {
      const callOptions = { gas: 600000 };
      const { receipt } = await suspectOptimist.rollback(callOptions);
      suspectLastTxId = receipt.transactionHash;
      suspectBondAmount = requiredBond;

      const suspectBalance = await suspectOptimist.getBalance();
      const suspectLocker = await suspectOptimist.getLocker();
      const suspectRollbackSize = await suspectOptimist.getRollbackSize();
      const optimismBalance = await web3.eth.getBalance(optimismAddress);
      const accountState = await suspectOptimist.getAccountState();

      expect(suspectBalance.toString()).to.equal(suspectBondAmount);
      expect(suspectLocker).to.equal(null);
      expect(suspectRollbackSize).to.equal(0);
      expect(optimismBalance.toString()).to.equal(suspectBondAmount);
      expect(accountState.equals(suspectOptimist.accountState)).to.be.true;

      if (receipt.gasUsed !== 334723) {
        console.log(`Not Critical, but we expected gas used for [ 19] to be 334723, but got ${receipt.gasUsed}`);
      }
    });

    it('[20] allows a user (suspect) to re-perform valid optimistic state transitions in batch.', async () => {
      const calls = 100;
      const someArgs = generateElements(calls, { seed: '55' });

      for (let i = 0; i < calls; i++) {
        const callArgs = [toHex(someArgs[i])];
        const newState = somePureTransition(suspect, suspectOptimist.queuedState, someArgs[i]);
        suspectOptimist.some_pure_transition.queue(callArgs, newState);
      }

      expect(suspectOptimist.transitionsQueued).to.equal(calls);

      const callOptions = { gas: 360000 };
      const { receipt } = await suspectOptimist.sendQueue(callOptions);
      suspectLastTxId = receipt.transactionHash;

      const accountState = await suspectOptimist.getAccountState();

      expect(suspectOptimist.transitionsQueued).to.equal(0);
      expect(accountState.equals(suspectOptimist.accountState)).to.be.true;

      if (receipt.gasUsed !== 328373) {
        console.log(`Not Critical, but we expected gas used for [ 20] to be 328373, but got ${receipt.gasUsed}`);
      }
    });

    it('[21] allows a user (accuser) to immediately verify valid batched optimistic state transitions (using local js).', async () => {
      const { valid, user } = await accuserOptimist.verifyTransaction(suspectLastTxId, { pureVerifiers });

      expect(valid).to.be.true;
      expect(user).to.equal(suspect.toLowerCase());
    });

    it('[22] allows a user (suspect) to perform a normal state transition (and exit optimism).', async () => {
      const networkId = await web3.eth.net.getId();

      if (networkId === 5777) {
        // Need to increase time by at least 600 seconds for this to be allowed
        await advanceTime(suspectOptimist.lastTime + 700);
        await advanceBlock();
      } else {
        // Need to wait at least 60 seconds for lock time to expire
        console.info('Waiting for 70 seconds...');
        await someDelay(70);
        console.info('Finished waiting.');
      }

      const someArg = generateElements(1, { seed: '88' })[0];

      const callArgs = [toHex(someArg)];
      const callOptions = { gas: 320000 };
      const { receipt } = await suspectOptimist.some_impure_transition.normal(callArgs, callOptions);
      const accountState = await suspectOptimist.getAccountState();

      expect(accountState.equals(suspectOptimist.accountState)).to.be.true;

      if (receipt.gasUsed !== 39683) {
        console.log(`Not Critical, but we expected gas used for [ 22] to be 39683, but got ${receipt.gasUsed}`);
      }
    });

    it('[23] allows a user (suspect) to perform valid optimistic state transitions in batch (and reenter optimism).', async () => {
      const calls = 50;
      const someArgs = generateElements(calls, { seed: '99' });

      for (let i = 0; i < calls; i++) {
        const callArgs = [toHex(someArgs[i])];
        const newState = somePureTransition(suspect, suspectOptimist.queuedState, someArgs[i]);
        suspectOptimist.some_pure_transition.queue(callArgs, newState);
      }

      expect(suspectOptimist.transitionsQueued).to.equal(calls);

      const callOptions = { gas: 200000 };
      const { receipt } = await suspectOptimist.sendQueue(callOptions);
      suspectLastTxId = receipt.transactionHash;

      const accountState = await suspectOptimist.getAccountState();

      expect(suspectOptimist.transitionsQueued).to.equal(0);
      expect(accountState.equals(suspectOptimist.accountState)).to.be.true;

      if (receipt.gasUsed !== 166913) {
        console.log(`Not Critical, but we expected gas used for [ 23] to be 166913, but got ${receipt.gasUsed}`);
      }
    });

    it('[24] allows a user (accuser) to immediately verify valid batched optimistic state transitions (using local js).', async () => {
      const { valid, user } = await accuserOptimist.verifyTransaction(suspectLastTxId, { pureVerifiers });

      expect(valid).to.be.true;
      expect(user).to.equal(suspect.toLowerCase());
    });
  });
});
