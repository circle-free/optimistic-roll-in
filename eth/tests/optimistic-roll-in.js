const chai = require('chai');
const { expect } = chai;
const crypto = require('crypto');

const OptimisticRollInArtifact = artifacts.require('Optimistic_Roll_In');
const SomeLogicContractArtifact = artifacts.require('Some_Logic_Contract');

const OptimisticRollIn = require('../../js/src');
const { to32ByteBuffer, hashPacked, toHex, toBuffer } = require('../../js/src/utils');

const somePureTransition = (currentState, arg) => {
  let newState = Buffer.isBuffer(currentState) ? currentState : toBuffer(currentState);
  arg = Buffer.isBuffer(arg) ? arg : toBuffer(arg);

  for (let i = 0; i < 1000; i++) {
    newState = hashPacked([newState, arg]);
  }

  return newState;
};

const someFraudTransition = (currentState, argHex) => {
  return to32ByteBuffer(1337);
};

const logicFunctions = {
  some_pure_transition: somePureTransition,
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

const zeroAddress = '0x0000000000000000000000000000000000000000';

contract('Optimistic Roll In', (accounts) => {
  describe('Basic Testing (must be performed in order)', async () => {
    let suspect = accounts[0];
    let accuser = accounts[1];

    let suspectOptimist = null;
    let accuserOptimist = null;
    let suspectLastTxId = null;

    let suspectBondAmount = null;
    let suspectDepositAmount = null;
    let accuserBondAmount = null;

    let logicContractInstance = null;
    let logicAddress = null;
    let optimismContractInstance = null;
    let fraudulentTransitionIndex = null;

    before(async () => {
      logicContractInstance = await SomeLogicContractArtifact.new();
      logicAddress = logicContractInstance.address;
      const initialStateSelector = logicContractInstance.abi.find(({ name }) => name === 'initialize_state').signature;
      optimismContractInstance = await OptimisticRollInArtifact.new(logicAddress, initialStateSelector);

      const oriOptions = { treeOptions: { elementPrefix: '00' }, web3 };

      suspectOptimist = new OptimisticRollIn(
        optimismContractInstance,
        logicContractInstance,
        logicFunctions,
        suspect,
        oriOptions
      );

      accuserOptimist = new OptimisticRollIn(
        optimismContractInstance,
        logicContractInstance,
        logicFunctions,
        accuser,
        oriOptions
      );
    });

    it('[ 1] can bond a user (who will eventually be the guilty suspect).', async () => {
      suspectBondAmount = '1000000000000000000';
      const { receipt } = await suspectOptimist.bond(suspectBondAmount);
      const bondBalance = await optimismContractInstance.balances(suspect);

      expect(bondBalance.toString()).to.equal(suspectBondAmount);
      expect(receipt.gasUsed).to.equal(42739);
    });

    it('[ 2] can initialize a user (suspect).', async () => {
      suspectDepositAmount = '500000000000000000';
      const additionalBond = '0';
      const options = { deposit: suspectDepositAmount, bond: additionalBond };
      const { receipt, logs } = await suspectOptimist.initialize(options);
      const accountState = await optimismContractInstance.account_states(suspect);
      const bondBalance = await optimismContractInstance.balances(suspect);
      const logicBalance = BigInt(await web3.eth.getBalance(logicAddress));

      expect(accountState).to.equal(toHex(suspectOptimist.accountState));
      expect(bondBalance.toString()).to.equal(suspectBondAmount);
      expect(logicBalance.toString()).to.equal(suspectDepositAmount);

      expect(logs[0].event).to.equal('ORI_New_State');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(toHex(suspectOptimist.currentState));

      expect(receipt.gasUsed).to.equal(53482);
    });

    it('[ 3] allows a user (suspect) to perform a normal state transition (and remain outside of optimism).', async () => {
      const someArg = generateElements(1, { seed: '11' })[0];

      const { receipt, logs } = await suspectOptimist.some_pure_transition.normal(toHex(someArg));
      const accountState = await optimismContractInstance.account_states(suspect);

      expect(accountState).to.equal(toHex(suspectOptimist.accountState));

      expect(logs[0].event).to.equal('ORI_New_State');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(toHex(suspectOptimist.currentState));

      expect(receipt.gasUsed).to.equal(287869);
    });

    it('[ 4] allows a user (suspect) to perform a valid optimistic state transition (and enter optimism).', async () => {
      const someArg = generateElements(1, { seed: '22' })[0];

      const { receipt, logs } = await suspectOptimist.some_pure_transition.optimistic(toHex(someArg));
      const accountState = await optimismContractInstance.account_states(suspect);
      suspectLastTxId = receipt.transactionHash;

      expect(logs[0].event).to.equal('ORI_New_Optimistic_State');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(suspectOptimist.lastTime.toString());

      expect(accountState).to.equal(toHex(suspectOptimist.accountState));

      expect(receipt.gasUsed).to.equal(33971);
    });

    it('[ 5] allows a user (accuser) to immediately verify a valid optimistic state transition.', async () => {
      const { valid, user } = await accuserOptimist.verifyTransaction(suspectLastTxId);

      expect(valid).to.be.true;
      expect(user).to.equal(suspect.toLowerCase());
    });

    it('[ 6] allows a user (suspect) to perform a valid optimistic state transition.', async () => {
      const someArg = generateElements(1, { seed: '33' })[0];

      const { receipt, logs } = await suspectOptimist.some_pure_transition.optimistic(toHex(someArg));
      const accountState = await optimismContractInstance.account_states(suspect);
      suspectLastTxId = receipt.transactionHash;

      expect(logs[0].event).to.equal('ORI_New_Optimistic_State');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(suspectOptimist.lastTime.toString());

      expect(accountState).to.equal(toHex(suspectOptimist.accountState));

      expect(receipt.gasUsed).to.equal(35790);
    });

    it('[ 7] allows a user (accuser) to immediately verify a valid optimistic state transition.', async () => {
      const { valid, user } = await accuserOptimist.verifyTransaction(suspectLastTxId);

      expect(valid).to.be.true;
      expect(user).to.equal(suspect.toLowerCase());
    });

    it('[ 8] allows a user (suspect) to perform valid optimistic state transitions in batch.', async () => {
      const calls = 100;
      const someArgs = generateElements(calls, { seed: '44' });

      for (let i = 0; i < calls; i++) {
        suspectOptimist.some_pure_transition.queue(toHex(someArgs[i]));
      }

      expect(suspectOptimist.transitionsQueued).to.equal(calls);

      const { receipt, logs } = await suspectOptimist.sendQueue();
      const accountState = await optimismContractInstance.account_states(suspect);
      suspectLastTxId = receipt.transactionHash;

      expect(suspectOptimist.transitionsQueued).to.equal(0);

      expect(logs[0].event).to.equal('ORI_New_Optimistic_States');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(suspectOptimist.lastTime.toString());

      expect(accountState).to.equal(toHex(suspectOptimist.accountState));

      expect(receipt.gasUsed).to.equal(286140);
    });

    it('[ 9] allows a user (accuser) to immediately verify valid batched optimistic state transitions.', async () => {
      const { valid, user } = await accuserOptimist.verifyTransaction(suspectLastTxId);

      expect(valid).to.be.true;
      expect(user).to.equal(suspect.toLowerCase());
    });

    it('[10] allows a user (suspect) to perform fraudulent optimistic state transitions in batch.', async () => {
      const fraudulentIndex = 20;
      fraudulentTransitionIndex = suspectOptimist.transitionCount + fraudulentIndex;

      const calls = 100;
      const someArgs = generateElements(calls, { seed: '55' });

      for (let i = 0; i < calls; i++) {
        if (i === fraudulentIndex) {
          // Hijack the internal function with a fraudulent one
          logicFunctions['some_pure_transition'] = someFraudTransition;
        }

        suspectOptimist.some_pure_transition.queue(toHex(someArgs[i]));

        if (i === fraudulentIndex) {
          // Reset the internal function with the proper one
          logicFunctions['some_pure_transition'] = somePureTransition;
        }
      }

      expect(suspectOptimist.transitionsQueued).to.equal(calls);

      // send the queue, but purposefully ignore internal checks, because suspect wants to commit fraud
      const { receipt, logs } = await suspectOptimist.sendQueue({ checkStates: false });
      const accountState = await optimismContractInstance.account_states(suspect);
      suspectLastTxId = receipt.transactionHash;

      expect(suspectOptimist.transitionsQueued).to.equal(0);

      expect(logs[0].event).to.equal('ORI_New_Optimistic_States');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(suspectOptimist.lastTime.toString());

      expect(accountState).to.equal(toHex(suspectOptimist.accountState));

      expect(receipt.gasUsed).to.equal(289219);
    });

    it('[11] allows a user (accuser) to immediately detect a transaction containing a fraudulent state transition.', async () => {
      const { valid, user } = await accuserOptimist.verifyTransaction(suspectLastTxId);

      expect(valid).to.be.false;
      expect(user).to.equal(suspect.toLowerCase());

      const fraudster = accuserOptimist.getFraudster(suspect);
      const accountState = await optimismContractInstance.account_states(suspect);

      expect(fraudster.fraudIndex).to.equal(fraudulentTransitionIndex);
      expect(accountState).to.equal(toHex(fraudster.accountState));
    });

    it('[12] allows a user (suspect) to perform a valid optimistic state transition on top of an invalid state.', async () => {
      const someArg = generateElements(1, { seed: '66' })[0];

      const { receipt, logs } = await suspectOptimist.some_pure_transition.optimistic(toHex(someArg));
      const accountState = await optimismContractInstance.account_states(suspect);
      suspectLastTxId = receipt.transactionHash;

      expect(logs[0].event).to.equal('ORI_New_Optimistic_State');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(suspectOptimist.lastTime.toString());

      expect(accountState).to.equal(toHex(suspectOptimist.accountState));

      expect(receipt.gasUsed).to.equal(38283);
    });

    it("[13] allows a user (accuser) to update their local partial tree with the suspect's pre-lockout valid transition.", async () => {
      const fraudster = accuserOptimist.getFraudster(suspect);

      await fraudster.update(suspectLastTxId);
      const accountState = await optimismContractInstance.account_states(suspect);

      // We expect this partial tree roots, when combined, to have the same root as the suspects combined trees on-chain
      expect(accountState).to.equal(toHex(fraudster.accountState));
    });

    it('[14] allows a user (suspect) to perform valid optimistic state transitions in batch on top of an invalid state.', async () => {
      const calls = 20;
      const someArgs = generateElements(calls, { seed: '77' });

      for (let i = 0; i < calls; i++) {
        suspectOptimist.some_pure_transition.queue(toHex(someArgs[i]));
      }

      expect(suspectOptimist.transitionsQueued).to.equal(calls);

      const { receipt, logs } = await suspectOptimist.sendQueue();
      const accountState = await optimismContractInstance.account_states(suspect);
      suspectLastTxId = receipt.transactionHash;

      expect(suspectOptimist.transitionsQueued).to.equal(0);

      expect(logs[0].event).to.equal('ORI_New_Optimistic_States');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(suspectOptimist.lastTime.toString());

      expect(accountState).to.equal(toHex(suspectOptimist.accountState));

      expect(receipt.gasUsed).to.equal(90425);
    });

    it("[15] allows a user (accuser) to lock a suspect's account for a time frame.", async () => {
      // An accuser, who previously detected the fraudulent transition will, will lock out the suspect (and bond themselves at the same time)
      accuserBondAmount = '1000000000000000000';
      const fraudster = accuserOptimist.getFraudster(suspect);
      const { receipt, logs } = await fraudster.lock({ bond: accuserBondAmount });

      const block = await web3.eth.getBlock(receipt.blockNumber);
      const balance = await optimismContractInstance.balances(accuser);
      const suspectLocker = await optimismContractInstance.lockers(suspect);
      const suspectLockedTime = await optimismContractInstance.locked_times(suspect);
      const accuserLocker = await optimismContractInstance.lockers(accuser);
      const accuserLockedTime = await optimismContractInstance.locked_times(accuser);

      expect(logs[0].event).to.equal('ORI_Locked');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1]).to.equal(accuser);

      expect(balance.toString()).to.equal(accuserBondAmount);

      expect(suspectLocker).to.equal(accuser);
      expect(suspectLockedTime.toString()).to.equal(block.timestamp.toString());
      expect(accuserLocker).to.equal(accuser);
      expect(accuserLockedTime.toString()).to.equal(block.timestamp.toString());

      expect(receipt.gasUsed).to.equal(128002);
    });

    it("[16] allows a user (accuser) to update their local partial tree with the suspect's pre-lockout valid transition.", async () => {
      const fraudster = accuserOptimist.getFraudster(suspect);

      await fraudster.update(suspectLastTxId);
      const accountState = await optimismContractInstance.account_states(suspect);

      // We expect this partial tree roots, when combined, to have the same root as the suspects combined trees on-chain
      expect(accountState).to.equal(toHex(fraudster.accountState));
    });

    it("[17] allows a user (accuser) to prove a suspect's fraud (from a partial tree).", async () => {
      const fraudster = accuserOptimist.getFraudster(suspect);

      // Prove the fraud
      const { receipt, logs } = await fraudster.proveFraud();

      expect(accuserOptimist.getFraudster(suspect)).to.equal(null);

      const suspectBalance = await optimismContractInstance.balances(suspect);
      const suspectLocker = await optimismContractInstance.lockers(suspect);
      const suspectLockedTime = await optimismContractInstance.locked_times(suspect);
      const suspectRollbackSize = await optimismContractInstance.rollback_sizes(suspect);

      const accuserBalance = await optimismContractInstance.balances(accuser);
      const accuserLocker = await optimismContractInstance.lockers(accuser);
      const accuserLockedTime = await optimismContractInstance.locked_times(accuser);

      const expectedAccuserBalance = web3.utils
        .toBN(suspectBondAmount)
        .add(web3.utils.toBN(accuserBondAmount))
        .toString();

      expect(logs[0].event).to.equal('ORI_Fraud_Proven');
      expect(logs[0].args[0]).to.equal(accuser);
      expect(logs[0].args[1]).to.equal(suspect);
      expect(logs[0].args[2].toString()).to.equal(fraudulentTransitionIndex.toString());
      expect(logs[0].args[3].toString()).to.equal(suspectBondAmount);
      suspectBondAmount = '0';

      expect(suspectBalance.toString()).to.equal('0');
      expect(suspectLocker).to.equal(suspect);
      expect(suspectLockedTime.toString()).to.equal('0');
      expect(suspectRollbackSize.toString()).to.equal(fraudulentTransitionIndex.toString());

      expect(accuserBalance.toString()).to.equal(expectedAccuserBalance);
      expect(accuserLocker).to.equal(zeroAddress);
      expect(accuserLockedTime.toString()).to.equal('0');

      expect(receipt.gasUsed).to.equal(298464);
    });

    it('[18] allows a user (accuser) to unbond their balance (including the reward).', async () => {
      const startingEth = BigInt(await web3.eth.getBalance(accuser));
      const { receipt } = await accuserOptimist.unbond(accuser);
      const endingEth = BigInt(await web3.eth.getBalance(accuser));
      const balanceUser0 = await optimismContractInstance.balances(suspect);
      const balanceUser1 = await optimismContractInstance.balances(accuser);

      accuserBondAmount = '0';

      expect((endingEth - startingEth).toString()).to.equal('1999578460000000000');
      expect(balanceUser0.toString()).to.equal('0');
      expect(balanceUser1.toString()).to.equal('0');
      expect(receipt.gasUsed).to.equal(21077);
    });

    it('[19] allows a user (suspect) to rollback their call data tree.', async () => {
      suspectBondAmount = '1000000000000000000';
      const { receipt, logs } = await suspectOptimist.rollback(fraudulentTransitionIndex, {
        bondAmount: suspectBondAmount,
      });

      const accountState = await optimismContractInstance.account_states(suspect);

      const suspectBalance = await optimismContractInstance.balances(suspect);
      const suspectLocker = await optimismContractInstance.lockers(suspect);
      const suspectRollbackSize = await optimismContractInstance.rollback_sizes(suspect);

      expect(logs[0].event).to.equal('ORI_Rolled_Back');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(fraudulentTransitionIndex.toString());
      expect(logs[0].args[2].toString()).to.equal(suspectOptimist.lastTime.toString());

      expect(suspectBalance.toString()).to.equal(suspectBondAmount);
      expect(suspectLocker).to.equal(zeroAddress);
      expect(suspectRollbackSize.toString()).to.equal('0');

      expect(accountState).to.equal(toHex(suspectOptimist.accountState));

      expect(receipt.gasUsed).to.equal(296934);
    });

    it('[20] allows a user (suspect) to re-perform valid optimistic state transitions in batch.', async () => {
      const calls = 100;
      const someArgs = generateElements(calls, { seed: '55' });

      for (let i = 0; i < calls; i++) {
        suspectOptimist.some_pure_transition.queue(toHex(someArgs[i]));
      }

      expect(suspectOptimist.transitionsQueued).to.equal(calls);

      // send the queue, but purposefully ignore internal checks, because suspect wants to commit fraud
      const { receipt, logs } = await suspectOptimist.sendQueue({ checkStates: false });
      const accountState = await optimismContractInstance.account_states(suspect);
      suspectLastTxId = receipt.transactionHash;

      expect(suspectOptimist.transitionsQueued).to.equal(0);

      expect(logs[0].event).to.equal('ORI_New_Optimistic_States');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(suspectOptimist.lastTime.toString());

      expect(accountState).to.equal(toHex(suspectOptimist.accountState));

      expect(receipt.gasUsed).to.equal(290483);
    });

    it('[21] allows a user (suspect) to perform a normal state transition (and exit optimism).', async () => {
      // Need to increase time by at least 600 seconds for this to be allowed
      await advanceTime(suspectOptimist.lastTime + 700);

      const someArg = generateElements(1, { seed: '88' })[0];

      const { receipt, logs } = await suspectOptimist.some_pure_transition.normal(toHex(someArg));
      const accountState = await optimismContractInstance.account_states(suspect);

      expect(accountState).to.equal(toHex(suspectOptimist.accountState));

      expect(logs[0].event).to.equal('ORI_New_State');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(toHex(suspectOptimist.currentState));

      expect(receipt.gasUsed).to.equal(289882);
    });

    it('[22] allows a user (suspect) to perform valid optimistic state transitions in batch (and reenter optimism).', async () => {
      const calls = 50;
      const someArgs = generateElements(calls, { seed: '99' });

      for (let i = 0; i < calls; i++) {
        suspectOptimist.some_pure_transition.queue(toHex(someArgs[i]));
      }

      expect(suspectOptimist.transitionsQueued).to.equal(calls);

      // send the queue, but purposefully ignore internal checks, because suspect wants to commit fraud
      const { receipt, logs } = await suspectOptimist.sendQueue({ checkStates: false });
      const accountState = await optimismContractInstance.account_states(suspect);
      suspectLastTxId = receipt.transactionHash;

      expect(suspectOptimist.transitionsQueued).to.equal(0);

      expect(logs[0].event).to.equal('ORI_New_Optimistic_States');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(suspectOptimist.lastTime.toString());

      expect(accountState).to.equal(toHex(suspectOptimist.accountState));

      expect(receipt.gasUsed).to.equal(147939);
    });
  });
});
