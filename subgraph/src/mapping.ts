import { BigInt } from "@graphprotocol/graph-ts"
import {
  Contract,
  ORI_Fraud_Proven,
  ORI_Locked,
  ORI_New_Optimistic_State,
  ORI_New_Optimistic_States,
  ORI_New_State,
  ORI_Rolled_Back,
  ORI_Unlocked
} from "../generated/Contract/Contract"
import { ExampleEntity } from "../generated/schema"

export function handleORI_Fraud_Proven(event: ORI_Fraud_Proven): void {
  // Entities can be loaded from the store using a string ID; this ID
  // needs to be unique across all entities of the same type
  let entity = ExampleEntity.load(event.transaction.from.toHex())

  // Entities only exist after they have been saved to the store;
  // `null` checks allow to create entities on demand
  if (entity == null) {
    entity = new ExampleEntity(event.transaction.from.toHex())

    // Entity fields can be set using simple assignments
    entity.count = BigInt.fromI32(0)
  }

  // BigInt and BigDecimal math are supported
  entity.count = entity.count + BigInt.fromI32(1)

  // Entity fields can be set based on event parameters
  entity.accuser = event.params.accuser
  entity.suspect = event.params.suspect

  // Entities can be written to the store with `.save()`
  entity.save()

  // Note: If a handler doesn't require existing field values, it is faster
  // _not_ to load the entity from the store. Instead, create it fresh with
  // `new Entity(...)`, set the fields that should be updated and save the
  // entity back to the store. Fields that were not set or unset remain
  // unchanged, allowing for partial updates to be applied.

  // It is also possible to access smart contracts from mappings. For
  // example, the contract that has emitted the event can be connected to
  // with:
  //
  // let contract = Contract.bind(event.address)
  //
  // The following functions can then be called on this contract to access
  // state variables and other data:
  //
  // - contract.account_states(...)
  // - contract.balances(...)
  // - contract.initializer(...)
  // - contract.lock_time(...)
  // - contract.locked_times(...)
  // - contract.lockers(...)
  // - contract.logic_address(...)
  // - contract.min_bond(...)
  // - contract.rollback_sizes(...)
}

export function handleORI_Locked(event: ORI_Locked): void {}

export function handleORI_New_Optimistic_State(
  event: ORI_New_Optimistic_State
): void {}

export function handleORI_New_Optimistic_States(
  event: ORI_New_Optimistic_States
): void {}

export function handleORI_New_State(event: ORI_New_State): void {}

export function handleORI_Rolled_Back(event: ORI_Rolled_Back): void {}

export function handleORI_Unlocked(event: ORI_Unlocked): void {}
