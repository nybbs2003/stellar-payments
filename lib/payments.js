var Promise     = require("bluebird");
var _           = require("lodash");
var Knex        = require("knex");

var Network     = require('./stellar-network');
var Signer      = require('./signer');
var Submitter   = require('./submitter');
var errors      = require('./errors');
var Database    = require('./database');

// The limit of new transactions we'll sign from the db
var DEFAULT_MAX_TRANSACTIONS = 10;
// polling for new transactions to sign. in ms
var POLL_INTERVAL = 1000;
// true if we're in the middle of checking confirming/submitting
var checkingTransactions = false;

/**
* Constructs a new Payments object.
* @param {object} config Configuration variables
* @param {string} config.stellarAddress The stellar account used for payouts.
* @param {string} config.stellarSecretKey The secret key for the stellar account.
* @param {object} config.db The database configuration (required if database is not provided)
* @param {string} config.db.client The type of client adapter. Knex supports (Postgres, MySQL, MariaDB and SQLite3)
* @param {object} config.db.connection Connection configuration params
* @param {string} config.db.connection.host
* @param {string} config.db.connection.password
* @param {string} config.db.connection.user
* @param {string} config.db.connection.database
* @param {object} [config.logger] The logger implementation. A standard console.log will be used in leui if none specified.
* @param {object} [config.network] The network implementation.
* @param {object} [config.database] The instantiated stellar payments database implementation.
*/
var Payments = function (config) {
    this.database   = config.database || new Database(config);
    this.network    = config.network || new Network(config);
    if (!this.database) {
        throw new Error("Must provide a database implementation or configuration parameters");
    }
    if (!this.network) {
        throw new Error("Must provide a network implementation or configuration parameters");
    }
    this.signer     = config.signer || new Signer(config, this.database, this.network);
    this.submitter  = config.submitter || new Submitter(config, this.database, this.network);

    this.stellarAddress = config.stellarAddress;
    // If true, should stop all processing
    this.fatalError = false;

    this.log = config.logger || require("./logger");
};

/**
* Process payments will:
* 1) Sign new transactions.
* 2) Submit unconfirmed transactions.
*
* @param {int} max_transactions The max transactions "in flight", we only will sign
*               (max - (signed submitted unconfirmed txns)). Default 10
*/
Payments.prototype.processPayments = function (max_transactions) {
    if (!max_transactions) {
        max_transactions = DEFAULT_MAX_TRANSACTIONS;
    }
    if (this.signingAndSubmitting) {
        // we're still processing the previous request
        return Promise.resolve();
    }
    this.signingAndSubmitting = true;
    // check to make sure we've got an initialized sequence number
    return Promise.bind(this)
        .then(this.checkFatalError)
        .then(this._ensureSequenceNumber)
        .then(function () {
            return this.calculateSigningLimit(max_transactions);
        })
        .then(this.signTransactions)
        .then(this.submitTransactions)
        .catch(Network.errors.NetworkError, function (err) {
            this.log.error("Network error", err);
        })
        .catch(this.handleFatalError)
        .finally(function () {
            this.signingAndSubmitting = false;
        });
};

Payments.prototype.handleFatalError = function (err) {
    // uncaugt exception, fatal error
    this.log.error("Fatal error", err);
    this.fatalError = err;
    return Promise.bind(this)
        .then(function () {
            // if this fatal error has a transaction, mark error as fatal
            if (err.transaction) {
                return this.database.markTransactionError(err.transaction, err.name, true);
            }
        })
        .then(function () {
            return Promise.reject(err);
        });
};

/**
* If the fatal error has a corresponding transaction, we first check if it's aborted. If it's aborted,
* we'll resign all the signed transactions.
*/
Payments.prototype.checkFatalError = function () {
    if (!this.fatalError) {
        return;
    }
    return Promise.bind(this)
        .then(function () {
            if (this.fatalError.transaction) {
                return this.database.isAborted(this.fatalError.transaction);
            } else {
                this.log.error("No transaction for this error");
                return false;
            }
        })
        .then(function (result) {
            if (!result) {
                this.log.error("There's been a fatal error, aborting");
                return Promise.reject(this.fatalError);
            } else {
                var transaction = this.fatalError.transaction;
                this.fatalError = null;
                return this._handleResignError(transaction);
            }
        });
};

/**
* Will sign the latest unsigned transactions in the db.
* @param {int} limit The limit of transactions to sign
*/
Payments.prototype.signTransactions = function(limit) {
    return this.signer.signTransactions(limit);
};

/**
* Will submit any signed and unconfirmed transactions to the network.
*/
Payments.prototype.submitTransactions = function () {
    var self = this;
    return Promise.bind(this)
        .then(function () {
            return this.submitter.submitTransactions();
        })
        .catch(Submitter.errors.ResignTransactionError, function (err) {
            var transaction = err.message;
            this._handleResignError(transaction);
        });
};

/**
* Initializes the local sequence number with the last sequence number we used to sign a transaction, by
* querying the database for the transaction with the highest seuqence number. If there's no transactions,
* we'll query the network for the last sequence number applied to the account. We'll locally keep track
* of and increment the sequence number as we sign new transactions.
*/
Payments.prototype.initSequenceNumber = function() {
    var self = this;
    return Promise.bind(this)
        .then(function () {
            return this.database.getHighestSequenceNumberFromTransactions();
        })
        .then(function (sequence) {
            if (!sequence) {
                // this will be the "current" sequence number, so no need to increment
                return self._getLatestSequenceNumberFromNetwork();
            } else {
                // this is the seq from the last transaction we've signed, so need to increment
                return sequence + 1;
            }
        })
        .then(function (sequence) {
            self.signer.setSequenceNumber(sequence);
        });
};

/**
* Calculates the max transactions we'll sign on the next iteration given max_transactions
*/
Payments.prototype.calculateSigningLimit = function (max_transactions) {
    return this.database.getSubmittedUnconfirmedTransactions()
        .then(function (result) {
            return max_transactions - result.length;
        });
};

// Ensure's we're initialized with the latest sequence number, either from the last signed txn in the db or the network
Payments.prototype._ensureSequenceNumber = function () {
    var self = this;
    return Promise.resolve(self.signer.getSequenceNumber())
        .then(function (sequence) {
            if (!sequence) {
                return self.initSequenceNumber();
            }
        });
};

Payments.prototype._getLatestSequenceNumberFromNetwork = function() {
    return this.network.getAccountInfo(this.stellarAddress)
        .then(function (result) {
            var sequence = result.result.account_data.Sequence;
            return sequence;
        });
};

/**
* When a signed transaction has errored and cannot be applied, any transactions that follow in sequence need to be resigned
* with a new sequence number.
*/
Payments.prototype._handleResignError = function (transaction) {
    var self = this;
    return Promise.bind(this)
        .then(function () {
            return this.database.clearSignedTransactionsFromId(transaction.id + 1);
        })
        .then(this._getLatestSequenceNumberFromNetwork)
        .then(function (sequence) {
            return this.signer.setSequenceNumber(sequence);
        });
};

module.exports = Payments;
