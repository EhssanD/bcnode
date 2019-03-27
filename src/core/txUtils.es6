/**
 * Copyright (c) 2018-present, BlockCollider developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */
import type PersistenceRocksDb from '../persistence/rocksdb'

const keccak = require('keccak')
const debug = require('debug')('bcnode:txutils')
// const { randomBytes } = require('crypto')
const { intToBuffer, bufferToInt } = require('../utils/buffer')
const secp256k1 = require('secp256k1')
const BN = require('bn.js')
const { overlineDistance } = require('../mining/primitives')
const { blake2bl } = require('../utils/crypto')
const { humanToBN, internalToBN, internalToHuman, MAX_NRG_VALUE, COIN_FRACS: { NRG, BOSON } } = require('./coin')
const { Transaction, TransactionOutput, OutPoint } = require('../protos/core_pb')
const toBuffer: (buf: Buffer|string) => Buffer = require('to-buffer')

/* CONSENSUS TX STATIC VALUES */
// 288-330 tx per block, eg 0.06 NRG per block
// 64000-155000 tx in tx panels per block (12800 TPS)
// 220 byte size on TX 109 compressed
// FIX protocol independent and secondary nodes
export const MAX_TXDIST_BLOCK = 92822807733198
export const HALF_MAX_TXDIST_BLOCK = 46411403866599
export const BASE_TX_DISTANCE_BLOCK = 331510027618
export const BASE_BLOCK_SIZE = 1 * 1024 * 1024
export const COINBASE_TX_ESTIMATE_SIZE = 256
export const COINBASE_MATURITY = 100
export const MINIMUM_EMBLEM_TO_NRG = 166
export const NRG_BLOCK_GRANT = 16
export const TX_DEFAULT_NONCE = '33e9fa317308a1e0002a65d650e27439fc046a8a14ae1862cb91f231bbc6d18f'
export const EMBLEM_GOLD_BCI_BLOCK = 66000000
export const EMBLEM_GOLD_WINDOW = 260000
// const TX_DEFAULT_FEE = humanToBN('0.06', NRG) // TODO: support floats
// const TX_DEFAULT_FEE = humanToBN('6', NRG)

// const EMBLEM_INPUT_TX_MAX = 5

// const isValidAddress = (addr: string): boolean => {
//  // 3PQ6wCS3zAkDEJtvGntQZbjuLw24kxTqndr WAVES
//  // 1813095620424213569L LISK
//  // 0xea674fdde714fd979de3edf0f56aa9716b898ec8 ETHEREUM
//  // 37HwfQDwX9RKwRR1o6TzdknodgCETVtYD6 BITCOIN
//  // AXSdN8Xsm2ZF3bzfz94Wo28EaTDKs9YA18 NEO
//  // 0x25cc7722a6378e11082f7967c09b98bd26c979d3 BLOCKCOLLIDER
// }

const isHexString = (val: string): bool => {
  const b = Buffer.from(val, 'hex')
  return (b.toString('hex') === val.toLowerCase())
}

// allowes to lock until height of ~ 2.815 * 10^14
// should be enough within next ~45755790 years assuming block time = 5s
const MAX_HEIGHT_HEX_LENGTH = 16

export class ScriptTemplates {
  static validateScript (script: string): boolean {
    // evaluate marketplace script
    if (script.indexOf('OP_MONOID') > -1 &&
        script.indexOf('OP_TAKERPAIR') > -1 &&
        script.indexOf('OP_DEPSET') > -1 &&
        script.indexOf('OP_MAKERCOLL') > -1) {
      debug('validating bound operations as marketplace transaction')
      return ScriptTemplates.validateMakerCollTakerPairScriptFormat(script)
    }
    // default evaluate standard NRG transfer
    return ScriptTemplates.validateNrgBalanceTransferScriptFormat(script)
  }
  /*
   * NRG Balance Transfer
   * Sends NRG from one addess to another
   */
  static validateNrgBalanceTransferScriptFormat (script: string): boolean {
    const parts = script.split(' ')
    const inputUnlockScriptPartsLength = 3

    if (parts.length !== inputUnlockScriptPartsLength && parts.length !== 5 && parts.length !== 7) {
      debug(`0 - l: ${parts.length}`)
      return false
    }

    if (parts.length === inputUnlockScriptPartsLength) { // input lock script
      const [signature, pubKey, _] = parts

      // secp256k1.publicKeyCreate with compressed = true produces 33B pub key
      if (pubKey.length !== 66 || !isHexString(pubKey)) {
        debug(`inS 1 - pk: ${pubKey.length}`)
        return false
      }

      // signData produces 65B signature
      if (signature.length !== 130 || !isHexString(signature)) {
        debug(`inS 2 - sig: ${signature.length}`)
        return false
      }

      // do not validate input script further
      return true
    }

    if (parts.length === 7) { // script with OP_CHECKLOCKTIMEVERIFY
      const [height, op] = parts
      if (height.length > MAX_HEIGHT_HEX_LENGTH || !isHexString(height)) {
        debug(`1 - h: ${height}`)
        return false
      }

      if (op !== 'OP_CHECKLOCKTIMEVERIFY') {
        debug(`2 - op: ${op}`)
        return false
      }
    }

    // last 5 tokens are the same
    let [opDup, opBlake, hash, opEq, opChecksig] = parts.slice(-5)
    if (opDup !== 'OP_DUP') {
      debug(`3 - op: ${opDup}`)
      return false
    }

    if (opBlake !== 'OP_BLAKE2BLC' && opBlake !== 'OP_BLAKE2BL' && opBlake !== 'OP_BLAKE2BLS') {
      debug(`4 - op: ${opBlake} unsupported hashing function`)
      return false
    }

    if (hash.length !== 64 || !isHexString(hash)) {
      debug(`5 - hash: ${hash}`)
      return false
    }

    if (opEq !== 'OP_EQUALVERIFY') {
      debug(`6 - op: ${opEq}`)
      return false
    }

    if (opChecksig !== 'OP_CHECKSIGVERIFY') {
      debug(`7 - op: ${opChecksig}`)
      return false
    }

    return true
  }
  /*
   * Maker Collateral + Taker Pair
   * Collateralizes NRG for decentralized exchange of value between blockchains
   *
   *  OP_MAKERCOLL
   *  this.OP_0() // failed
   *  this.OP_1() // NA
   *  this.OP_2() // taker & maker pass
   *  this.OP_3() // maker succeed, taker failed
   *  this.OP_4() // taker succeed, maker failed

    MAKER OUPUT SCRIPT:
    OP_MONOID [0] [450] [800] OP_DEPSET
    0 OP_IFEQ OP_RETURN OP_ENDIFEQ // OP_0 ERROR
    2 OP_IFEQ OP_TAKERPAIR 2 OP_MINUNITVALUE OP_RETURN OP_ENDIFEQ
    3 OP_IFEQ OP_RETURN OP_ENDIFEQ
    [maker-pay-from-chain-name] [maker-receives-chain-name] [maker-receives-address] <rateAmount> OP_MAKERCOLL (maker wants 1 unit of btc)
         // [maker-pay-from-chain-name] [maker-receives-chain-name] [maker-receives-address] <rateAmount> OP_MAKERCOLL (maker wants 1 unit of btc)
         // [numerChain] [denomChain] [maker-receives-address] <rateAmount> OP_MAKERCOLL (maker wants 1 unit of btc)
         // eth btc btcAddress rateAmount OP_MAKERCOLL (maker wants 1 unit of btc)
    3 OP_IFEQ
      OP_BLAKE2BL [MakerAddress] OP_EQ OP_CHECKSIGVERIFY
    OP_ENDIFEQ
    2 OP_IFEQ
      1 OP_MINUNITVALUE
      OP_MONAD
        OP_BLAKE2BL [MakerAddress] OP_EQ OP_CHECKSIGVERIFY
      OP_ENDMONAD
    OP_ENDIFEQ
   */
  static validateMakerCollTakerPairScriptFormat (script: string): boolean {
    const parts = script.split(' ')
    debug(`template - MakerCollTakerPair`)
    if (!parts.includes('OP_MONOID')) {
      return false
    }

    const makerOutputScriptPartsLen = 44
    const takerInputScriptPartsLen = 2
    if (parts.length !== (makerOutputScriptPartsLen + takerInputScriptPartsLen)) {
      return false
    }
    if (parts[takerInputScriptPartsLen] !== 'OP_MONOID') {
      return false
    }

    try {
      const txWindowParams = parts.splice(takerInputScriptPartsLen + 1, 3)
      for (let val of txWindowParams) {
        if (isNaN(val)) {
          return false
        }
      }

      const outputScript = parts.splice(takerInputScriptPartsLen).join(' ')
      const makerOutputScriptInfo = extractInfoFromCrossChainTxMakerOutputScript(outputScript)
      const reConstructedOutputScript = ScriptTemplates.createCrossChainTxMakerOutputScript(
        makerOutputScriptInfo.shiftStartsAt, makerOutputScriptInfo.depositEndsAt, makerOutputScriptInfo.settleEndsAt,
        makerOutputScriptInfo.paysChainId, makerOutputScriptInfo.wantsChainId,
        makerOutputScriptInfo.wantsAddress, makerOutputScriptInfo.wantsUnit, makerOutputScriptInfo.paysUnit,
        makerOutputScriptInfo.doubleHashedBcAddress, true
      )

      if (reConstructedOutputScript !== outputScript) {
        return false
      }
    } catch (e) {
      return false
    }
    return true
  }

  // TODO: move NRG transfer output script login from engine.index to here

  static createNRGOutputLockScript (bcAddress: string): string {
    const script = [
      'OP_BLAKE2BL',
      blake2bl(blake2bl(bcAddress.toLowerCase())),
      'OP_EQUALVERIFY',
      'OP_CHECKSIGVERIFY'
    ]
    return script.join(' ')
  }

  static createCrossChainTxTakerOutputCallbackScript (makerTxHash: string, makerTxOutputIndex: string|number): string {
    return [makerTxHash, makerTxOutputIndex, 'OP_CALLBACK'].join(' ')
  }

  static createCrossChainTxTakerOutputScript (
    makerTxHash: string, makerTxOutputIndex: string|number, takerBCAddress: string
  ): string {
    const doubleHashedBcAddress = blake2bl(blake2bl(takerBCAddress))
    const script = [
      [makerTxHash, makerTxOutputIndex, 'OP_CALLBACK'],
      ['4', 'OP_IFEQ', 'OP_BLAKE', doubleHashedBcAddress, 'OP_CHECKSIGVERIFY', 'OP_ENDIFEQ'],
      ['OP_MONAD', 'OP_BLAKE', doubleHashedBcAddress, 'OP_CHECKSIG', 'OP_ENDMONAD']
    ]
    return script.map(part => part.join(' ')).join(' ')
  }

  static createCrossChainTxTakerInputScript (takerWantsAddress: string, takerSendsAddress: string): string {
    return [takerWantsAddress, takerSendsAddress].join(' ')
  }

  static createCrossChainTxMakerOutputScript (
    shiftStartsAt: string|number, depositEndsAt: string|number, settleEndsAt: string|number,
    paysFromChainId: string, wantsToChainId: string,
    makerWantsAddress: string, makerWantsUnit: string, makerPaysUnit: string,
    makerBCAddress: string, isMakerAddressHashed: boolean = false
  ): string {
    let doubleHashedBcAddress = makerBCAddress
    if (!isMakerAddressHashed) {
      doubleHashedBcAddress = blake2bl(blake2bl(makerBCAddress))
    }

    const script = [
      ['OP_MONOID', shiftStartsAt, depositEndsAt, settleEndsAt, 'OP_DEPSET'],
      ['OP_0', 'OP_IFEQ',
        'OP_RETURN', 'OP_ENDIFEQ'],
      ['OP_2', 'OP_IFEQ',
        'OP_TAKERPAIR', '2', 'OP_MINUNITVALUE', 'OP_RETURN', 'OP_ENDIFEQ'],
      ['OP_3', 'OP_IFEQ',
        'OP_RETURN', 'OP_ENDIFEQ'],
      [paysFromChainId, wantsToChainId, makerWantsAddress, makerWantsUnit, makerPaysUnit, 'OP_MAKERCOLL'],
      ['OP_3', 'OP_IFEQ',
        'OP_BLAKE2BL', doubleHashedBcAddress, 'OP_EQ', 'OP_CHECKSIGVERIFY', 'OP_ENDIFEQ'],
      ['OP_2', 'OP_IFEQ',
        '1', 'OP_MINUNITVALUE', 'OP_MONAD', 'OP_BLAKE2BL', doubleHashedBcAddress, 'OP_EQ', 'OP_CHECKSIGVERIFY', 'OP_ENDMONAD', 'OP_ENDIFEQ']
    ]
    return script.map(part => part.join(' ')).join(' ')
  }
}

export const getScriptStrFromBuffer = (scriptBuffer: Uint8Array): string => {
  return Buffer.from(scriptBuffer, 'ascii').toString('ascii')
}

export const extractInfoFromCrossChainTxTakerOutputScript = (script: string): {
  makerTxHash: string,
  makerTxOutputIndex: number,
  doubleHashedBcAddress: string
} => {
  if (script.indexOf('OP_CALLBACK') === -1) {
    throw new Error('Invalid taker outpout script')
  }
  const [makerTxHash, makerTxOutputIndex] = script.split(' OP_CALLBACK')[0].split(' ')
  const doubleHashedBcAddress = script.split(' OP_BLAKE ')[1].split(' ')[0]

  return {
    makerTxHash: makerTxHash,
    makerTxOutputIndex: parseInt(makerTxOutputIndex, 10),
    doubleHashedBcAddress: doubleHashedBcAddress
  }
}

export const extractInfoFromCrossChainTxTakerInputScript = (script: string): {
  takerWantsAddress: string,
  takerSendsAddress: string
} => {
  const [takerWantsAddress, takerSendsAddress] = script.split(' ')
  return {
    takerWantsAddress: takerWantsAddress,
    takerSendsAddress: takerSendsAddress
  }
}

export const extractInfoFromCrossChainTxMakerOutputScript = (script: string): {
  shiftStartsAt: number,
  depositEndsAt: number,
  settleEndsAt: number,
  paysChainId: string,
  wantsChainId: string,
  wantsAddress: string,
  wantsUnit: string,
  paysUnit: string,
  doubleHashedBcAddress: string
} => {
  const [shiftStartsAt, depositEndsAt, settleEndsAt] = script.split(' OP_DEPSET ')[0].split(' ').slice(1)
  const tradeInfo = script.split(' OP_MAKERCOLL ')[0].split(' ')
  const [paysChainId, wantsChainId, wantsAddress, wantsUnit, paysUnit] = tradeInfo.slice(tradeInfo.length - 5)

  const doubleHashedBcAddress = script.split(' OP_IFEQ OP_BLAKE2BL ')[1].split(' ')[0]

  return {
    shiftStartsAt: parseInt(shiftStartsAt, 10),
    depositEndsAt: parseInt(depositEndsAt, 10),
    settleEndsAt: parseInt(settleEndsAt, 10),
    paysChainId: paysChainId,
    wantsChainId: wantsChainId,
    wantsAddress: wantsAddress,
    wantsUnit: wantsUnit,
    paysUnit: paysUnit,
    doubleHashedBcAddress: doubleHashedBcAddress
  }
}

// takes proto Transaction and returns blake2bl doubled string
export const txHash = (tx: Transaction): string => {
  const obj = tx.toObject()
  const inputs = obj.inputsList.map(input => {
    return [
      input.outPoint.value,
      input.outPoint.hash,
      input.outPoint.index,
      input.scriptLength,
      input.inputScript
    ].join('')
  }).join('')

  const outputs = obj.outputsList.map(output => {
    return [
      output.value,
      output.unit,
      output.scriptLength,
      output.outputScript
    ].join('')
  }).join('')

  const parts = [
    obj.version,
    obj.nonce,
    obj.overline,
    obj.ninCount,
    obj.noutCount,
    obj.lockTime,
    inputs,
    outputs
  ]

  const prehash = blake2bl(parts.join(''))
  const hash = blake2bl(prehash)
  return hash
}

// FIXME <- no fix needed, needs to sign all outputs and the outpoint must include the tx hash + the index
// takes proto of OutPoint and list of proto TransactionOutput returns buffer hash
export const outPointOutputHash = (outpoint: OutPoint, outputs: TransactionOutput[]): string => {
  const outputsData = outputs.map(output => {
    var obj = output.toObject()
    return [
      obj.value,
      obj.unit,
      obj.scriptLength,
      obj.outputScript
    ].join('')
  }).join('')

  const parts = [
    internalToHuman(outpoint.getValue(), NRG),
    outpoint.getHash(),
    outpoint.getIndex(),
    outputsData
  ]

  const hash = blake2bl(parts.join(''))
  return hash
}

// sign data ANY with private key Buffer
// return 65B long signature with recovery number as the last byte
export const signData = (data: string|Buffer, privateKey: Buffer): Buffer | Error => {
  data = toBuffer(data)
  const dataHash = blake2bl(data)
  const sig = secp256k1.sign(Buffer.from(dataHash, 'hex'), privateKey)

  if (sig.signature.length !== 64) {
    throw Error(`Signature should always be 64B long, l: ${sig.signature.length}`)
  }
  const signatureWithRecovery = Buffer.concat([
    sig.signature,
    intToBuffer(sig.recovery)
  ])

  return signatureWithRecovery
}

/**
 * Accepts signedData by rawSignature and recovers a publicKey from these
 *
 * @param {string} signedData data which where signed by rawSignature, usually hash of TX
 * @param {Buffer} rawSignature in 66B format (recovery number added to the end of signature)
 * @returns {Buffer} 64B public key
 */
export const pubKeyRecover = (signedData: string, rawSignature: Buffer): Buffer => {
  const pubKey = secp256k1.recover(
    Buffer.from(signedData, 'hex'),
    rawSignature.slice(0, 64),
    bufferToInt(rawSignature.slice(64))
  )
  return secp256k1.publicKeyConvert(pubKey, false).slice(1)
}

// create input signature of current tx referencing outpoint
export const txInputSignature = (outpoint: OutPoint, tx: Transaction, privateKey: Buffer): Buffer | Error => {
  const dataToSign = generateDataToSignForSig(outpoint, tx)
  const sig = signData(dataToSign, privateKey)

  return sig
}

export const generateDataToSignForSig = (outPoint: OutPoint, tx: Transaction): string => {
  return outPointOutputHash(outPoint, tx.getOutputsList())
}

export const calcTxFee = (tx: Transaction): BN => {
  const inputs = tx.getInputsList()
  let valueIn = inputs.reduce((valueIn, input) => {
    return valueIn.add(internalToBN(input.getOutPoint().getValue(), BOSON))
  }, new BN(0))

  const outputs = tx.getOutputsList()
  let valueOut = outputs.reduce((valueOut, output) => {
    return valueOut.add(internalToBN(output.getValue(), BOSON))
  }, new BN(0))

  return valueIn.sub(valueOut)
}

/**
 * Creates pair of transactions and private key transactions which original from a coinbase
 * @returns [Buffer] private keys and transactions protobuf
 */
export const newBlankTxs = (n: number = 2): Transaction[] => {
  const list = []
  for (var i = 0; i < n; i++) {
    list.push(new Transaction())
  }
  return list
}

export const isTxValid = (tx: Transaction): boolean => {
  return false
}

export const getTxDistance = (tx: Transaction): BN => {
  let nonce = TX_DEFAULT_NONCE
  if (tx.getNonce() !== undefined && tx.getNonce() !== '' && tx.getNonce() !== '0') {
    nonce = tx.getNonce()
  }
  // note the outpoint of the first input is used in the tx
  const inputs = tx.getInputsList()
  if (inputs.length < 1) {
    // coinbase transactions cannot have distance
    return new BN(0)
  }
  if (inputs[0].getOutPoint() === undefined || inputs[0].getOutPoint() === '' || inputs[0].getOutPoint() === '0') {
    // coinbase transactions cannot have distance
    return new BN(0)
  }
  const outPoint = tx.getInputsList()[0].getOutPoint()
  const checksum = tx.getHash() + outPoint.getHash() + outPoint.getIndex()
  return new BN(overlineDistance(blake2bl(nonce), blake2bl(checksum)))
}

// gets the distances summed for the given Transactions
export const getTxsDistanceSum = (txs: Transaction[]): BN => {
  const txDistanceSum = txs.reduce((all, tx, i) => {
    if (i === 0) {
      // coinbase does not add distance
    }
    all = all.add(getTxDistance(tx))
    return all
  }, new BN(0))

  return txDistanceSum
}

/* Calculates the additional Distance available to the block based on the Emblem Balance */
export const emblemToNrg = (emblems: number): number => {
  let amount = NRG_BLOCK_GRANT
  if (emblems < MINIMUM_EMBLEM_TO_NRG) {
    return amount
  } else {
    amount = NRG_BLOCK_GRANT + Math.log(emblems) * Math.log(emblems / 399)
    if (amount < NRG_BLOCK_GRANT) {
      amount = NRG_BLOCK_GRANT
    }
    if (amount > 166) {
      amount = 166
    }
    return Math.round(amount)
  }
}

/* Calculates the additional Distance available to the block based on the Emblem Balance */
export const getMaxDistanceWithEmblems = async (address: string, persistence: PersistenceRocksDb): Promise<{ totalDistance: BN, emblemBonus: number }> => {
  // half of the median distance of block is always carried at a cost of 166 NRG per distance unit
  // remaining half extended by emblem distance
  // the percentage consumed by the added emblem distance and other half is amount of extra nrg grant you get
  const distanceAsNrg = new BN(HALF_MAX_TXDIST_BLOCK).div(humanToBN('166', NRG))
  const emblemBalance = await persistence.getMarkedBalanceData(address)
  const emblemMultiplier = emblemToNrg(emblemBalance)
  const newTotalDistance = new BN(MAX_TXDIST_BLOCK).add(new BN(emblemMultiplier).mul(distanceAsNrg))
  // core permission
  return { totalDistance: newTotalDistance, emblemBonus: emblemMultiplier }
}

export const getMaxBlockSize = async (address: string, persistence: PersistenceRocksDb): Promise<number> => {
  const emblemBalance = await persistence.getMarkedBalanceData(address)
  if (emblemBalance < MINIMUM_EMBLEM_TO_NRG) {
    return BASE_BLOCK_SIZE
  }
  return BASE_BLOCK_SIZE + 256 * Math.log(emblemBalance) * Math.log(emblemBalance / MINIMUM_EMBLEM_TO_NRG)
}

/*
 * getNrgGrant returns the nrg awarded to a block
 * @param potentialEmblemNrg {number} generated from
 * @param distanceWithEmblems {BN} the theoretical new maximum with Emblems
 * @param txsConsumedDistance {BN} the a
 * @param blockHeight {BN} the current block height being mined
 * Calculates if and how much additional NRG the miners receives for the block
 */

export const getNrgGrant = (potentialEmblemNrg: number, distanceWithEmblems: BN, txsConsumedDistance: BN, blockHeight: BN): number => {
  if (potentialEmblemNrg <= NRG_BLOCK_GRANT) {
    return NRG_BLOCK_GRANT
  }
  // the transaction is invalid if it exceeds the total distance
  if (new BN(distanceWithEmblems).lt(new BN(txsConsumedDistance))) {
    throw new Error(`invalid transaction as it distanceWithEmblems: ${distanceWithEmblems} exceeds the txsconsumeddistance: ${distanceWithEmblems}`)
  }
  // Emblem Gold distribution after BCI_BLOCK height -> all Emblem owners NRG increase until 2036
  let emblemGold = 0
  if (new BN(blockHeight).gt(new BN(EMBLEM_GOLD_BCI_BLOCK))) {
    emblemGold = Math.round(new BN(new BN(blockHeight).sub(EMBLEM_GOLD_BCI_BLOCK)).div(new BN(EMBLEM_GOLD_WINDOW)).toNumber())
  }
  const minimumEmblemGrant = Math.round(potentialEmblemNrg / 5) // 20% with 80% penalty
  const divisor = new BN(distanceWithEmblems).div(new BN(txsConsumedDistance))
  let finalNrgGrant = Math.round(new BN(divisor.mul(new BN(potentialEmblemNrg))).toNumber())
  if (finalNrgGrant < minimumEmblemGrant) {
    finalNrgGrant = minimumEmblemGrant
  }
  if (emblemGold > 0) {
    finalNrgGrant = finalNrgGrant + emblemGold
  }
  return finalNrgGrant
}

// Miner create coinbase
export const txCreateCoinbase = async (
  currentBlockHeight: number,
  persistence: PersistenceRocksDb, // persistence layer from which to load transactions
  blockTxs: Transaction[], // all other transactions for block
  minerAddress: string
): Transaction => {
  const tx = new Transaction()

  const txsDistanceSum = getTxsDistanceSum(blockTxs)
  const emblemObject = await getMaxDistanceWithEmblems(minerAddress, persistence)

  let mintedNrg = await persistence.getNrgMintedSoFar()
  if (!mintedNrg) {
    mintedNrg = 0
  }
  let nrgGrant = 0
  if (mintedNrg < MAX_NRG_VALUE) {
    nrgGrant = getNrgGrant(emblemObject.emblemBonus, emblemObject.totalDistance, txsDistanceSum, currentBlockHeight)
  }
  if (mintedNrg + nrgGrant > MAX_NRG_VALUE) {
    nrgGrant = MAX_NRG_VALUE - mintedNrg
  }
  const txFees = blockTxs.map(tx => calcTxFee(tx)).reduce((fee, sum) => sum.add(fee), new BN(0))
  // grant unit == NRG
  const grant = humanToBN(`${nrgGrant}`, NRG).add(new BN(txFees))
  const unit = new BN(1).toBuffer()
  const newOutputLockScript = [
    'OP_BLAKE2BL',
    blake2bl(blake2bl(minerAddress)),
    'OP_EQUALVERIFY',
    'OP_CHECKSIGVERIFY'
  ].join(' ')

  // Miner grant to miner address
  const newOutput = new TransactionOutput([
    new Uint8Array(grant.toBuffer()), // NRG reward
    new Uint8Array(unit),
    newOutputLockScript.length,
    new Uint8Array(Buffer.from(newOutputLockScript, 'ascii'))
  ])

  // NOTE: It is important that all new outputs are added to TX before the creation of the input signature
  tx.setOutputsList([newOutput])

  const inputs = []

  tx.setInputsList(inputs)
  tx.setNinCount(inputs.length) // Number of Emblem transactions input
  tx.setNoutCount(1)
  tx.setNonce(minerAddress)
  tx.setOverline('0')
  tx.setLockTime(currentBlockHeight + COINBASE_MATURITY)
  tx.setVersion(1)

  tx.setHash(txHash(tx))
  return tx
}
// fees for transaction are not void

// key is has to be uncompressed public key
export const pubKeyToAddr = (key: Buffer): Buffer => {
  const digest = keccak('keccak256').update(key.slice(1)).digest()

  // see https://github.com/ethereumjs/ethereumjs-util/blob/master/index.js#L317
  return digest.slice(-20)
}

export const pubKeyToAddrHuman = (addr: Buffer): string => {
  // see https://github.com/ethereumjs/ethereumjs-util/blob/master/index.js#L317
  return `0x${pubKeyToAddr(addr).toString('hex')}`
}
