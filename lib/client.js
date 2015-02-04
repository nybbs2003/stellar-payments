#!/usr/bin/env node
var Knex = require("knex");
var Promise = require("bluebird");

var SqlDb = require("./sql-database");
var UInt160 = require("stellar-lib").UInt160;

/**
* A client provides functions for a client of the payments library to use to:
* - create a new payment
* @param {object} config
* @param {object} config.db The database configuration (required if database is not provided)
* @param {string} config.db.client The type of client adapter. Knex supports (Postgres, MySQL, MariaDB and SQLite3)
* @param {object} config.db.connection Connection configuration params
* @param {string} config.db.connection.host
* @param {string} config.db.connection.password
* @param {string} config.db.connection.user
* @param {string} config.db.connection.database
* @param {object} [config.database] The database implementation.
*/
var Client = function (config) {
    this.database = config.database || new SqlDb({connection: Knex.initialize(config.db)});
    if (!this.database) {
        throw new Error("Must provide a database implementation or configuration parameters");
    }
};

/**
* Creates a new payment.
*
* @param {string} address The destination address the payment will send to.
* @param {number|object} amount The amount of stellars to send or the amount object to send (value/currency/issuer pair).
* @param {number} [amount.value] The amount of the currency to send.
* @param {string} [amount.currency] The currency to send (USD, EUR, etc). If unspecified, will default to STR.
* @param {string} [amount.issuer] The issuing address for the currency. If unspecified, will use sending address.
* @param {string} [memo] A memo to describe this payment.
* @returns {Promise} A promise which will resolve once the payment has been created.
*/
Client.prototype.createNewPayment = function (address, amount, memo) {
    if (!UInt160.is_valid(address)) {
        throw new Error("Address must be a valid Stellar address");
    }
    validateAmount(amount);
    return Promise.bind(this)
        .then(function () {
            return this.database.insertNewTransaction(address, amount, memo);
        });
};

// validate we have a correct amount object
function validateAmount(amount) {
    if (!amount) {
        throw new Error("Amount cannot be null");
    }
    if (typeof(amount) !== "number" && typeof(amount) !== "object") {
        throw new Error("Amount must be either a number or an amount object.");
    }
    if (typeof(amount) === "object") {
        if (!amount.value || isNaN(Number(amount.value))) {
            throw new Error("Amount object must have an int for property 'value.'");
        }
        if (amount.currency && typeof(amount.currency) !== "string") {
            throw new Error("Amount currency property must be a string");
        }
        if (amount.issuer && !UInt160.is_valid(amount.issuer)) {
            throw new Error("Issuer must be a valid stellar address");
        }
    }
    return Promise.resolve();
}

module.exports = Client;
