# optimistic-roll-in

### Status

Just a Proof Of Concept, with Smart Contracts and JS Client. Only "happy path" tested. No security review. Feedback welcome and wanted.
<br>

### Brief

If your contract(s) has any functionality that results in isolated state changes for individual accounts (which means you could rewrite certain function to take in the user's state, and some arguments, and result in a new state, via a pure function) then this library *should* allow your users to perform Optimistic Roll Ins. Effectively, your users can assert their intent to the chain, by providing their current state, the call data they *would have* sent to the chain normally, and their expected new state, and optimistically update their state, without wasting any gas actually performing the on-chain verifications and logic. They can perform as many of these state transitions as they want, one at a time, or even cheeper in batch (allowing for offline play and syncing afterwards), and any other users can validate their proposed state changes after the fact, and prove if anyone committed fraud. Users can enter and exit this "optimistic" state at will (some conditions) so that they can perform non-optimistic transitions that are the result on non-pure functions in your contract.

Things to note:
* There is a small overhead for each call, associated with the Optimistic functionality, so if all or most of your normal state transitions are cheaper than that, then it may not make sense to use this. The overhead varies, depending on the type of data.
* This is ideal for things like games that have some single-player component, since many account state transitions don't rely on the shared world's state.
* This is ideal for things that involve very expensive proofs (like ZKPs, where 90%+ of transaction gas is spent verifying the proof), since they can be performed optimistically, and verified offline by others, and challenged on-chain.
* This is not ideal not ideal if the "world state" (i.e. global/shared variables) are used throughout your code, since it means your state transitions are not "pure".
* There is no L2 here. As a matter of fact, this is layer-agnostic, which means that while it could run on its own on mainnet, it could theoretically run on EVM-based L2s (like Optimism / Optimistic Roll Up).

Examples and more coming soon. Feel free to reach out with questions.
