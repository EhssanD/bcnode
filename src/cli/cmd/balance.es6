/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

const config = require('../../../config/config')
const DATA_DIR = process.env.BC_DATA_DIR || config.persistence.path

const { Command } = require('commander')

export const cmd = (program: typeof Command, address: string) => {
  if (program.opts().show) {
    console.log(JSON.stringify(config, null, 2))
    return
  }
  const RocksDb = require('../../persistence').RocksDb
  const db = new RocksDb(DATA_DIR)
  console.log("Loading balance for address " + address)
  return db.open()
  .then(() => db.getBtAddressBalance(address))
  .then((res) => {
    console.log(res)
    db.close()
  })
  .catch((err) => {
    db.close()
    throw new Error(err)
  })
}
