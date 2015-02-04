Stellar Payments
=====================

[![Build Status](https://travis-ci.org/stellar/stellar-payments.svg?branch=master)](https://travis-ci.org/stellar/stellar-payments) [![Coverage Status](https://coveralls.io/repos/stellar/stellar-payments/badge.png?branch=master)](https://coveralls.io/r/stellar/stellar-payments?branch=master)

####Important: stellar-payments library should point to only one stellard node. live.stellar.org is load balanced, so we have set up public1.stellar.org which points to a dedicated stellar node via elastic ip. This should be used as the stellard hostname in the config.

Stellar Payments is a Node JS library providing robust transaction submission to the Stellar network. Out of the box, it will correctly handle:

* local signing of transactions
* failed submission due to network failures or stellard downtime
* transaction errors such as tecPATH_DRY, tefPAST_SEQ, tefALREADY, and many others
* sequence number management
* maintaining idempotence ensuring no double payouts
* safe resigning due to ter/tem/tef transaction errors
* unfunded payments (if the account runs out of funds)
* fatal errors, will stop processing and require manual intervention
* TODO: fee changes

Additionaly, the library is extremely flexible and allows the client to provide their own implementation of the various components (referred to as modules) at runtime, including: transaction persistance, signing, submitting, logging, and networking.

### Basic Integration

#### Setting up the database
Stellar Payments relies on a persistent storage mechanism to keep track of payment transactions. The library supports
SQL storage out of the box, but you'll first have to add the Transactions table to your db.

1. `cp ./node_modules/stellar-payments/config.js ./`
2. Enter your db config into config.js
3. `node ./node_modules/stellar-payments/bin/db-setup`

#### Insert a new payment
```js
var PaymentsClient = require('stellar-payments').Client;
var payments = new PaymentsClient(config);

// create a payment. use an amount object for a currency, or just an integer (in stellars) for a stellar payment
payments.createNewPayment(<destination>, {value: 1, currency: "USD", issuer:<issuing address>}, "memo");
```

#### Processing Payments
```js
var StellarPayments = require('stellar-payments').Payments;
var payments = new StellarPayments(config);

processPayments();

// calls processPayments every 500 ms
function processPayments() {
    setInterval(function () {
        payments.processPayments(MAX_TRANSACTIONS)
            .catch(function (err) {
                // report fatal error
            });
    }, POLL_INTERVAL);
}
```

### Architecture
At its core, Stellar Payments is simply a transaction signing and submission management tool. It provides a robust implementation that is useful out of the box with limited configuration, yet is abstracted enough to allow custom implementation for its various modules.

The code is architected into several discrete modules:

<img src="https://cloud.githubusercontent.com/assets/993607/5429719/e08540b2-83ab-11e4-8e11-e5392ab6e699.png" alt="Drawing" style="width: 400px;"/>

##### lib/payments.js - Core payments driver
The Payments class provides the core function processPayments() which drives the signing/submitting process. The client will call this function at a regular interval. The Payments class depends on the database, signer, submitter, and network.

##### lib/database.js - Persistent Transaction Store

Stellar Payments uses persistent storage to keep track of transactions through the various transaction states. Stellar Payments includes a SQL schema and a Knex implementation which supports various SQL libraries. See the database module for more information.

##### lib/network.js - Stellar Network Interface
Provides methods that access payment specific endpoints in the stellar network.

##### lib/signer.js - Transaction Signer

The signer manages the sequence number and signs transactions. The default implementation signs transactions locally. If there's an error signing a transaction, it will mark the transaction with a malformed error and continue.

##### lib/submitter.js - Transaction Submitter

The submitter takes signed and submitted transactions and submits them to the network in sequence order. It handles errors and determines when a transaction is confirmed. See Submission Confirmation and Error Handling for more information.


### Transaction object

The transaction data structure represents a single transaction and its associated meta information. Any interface that depends on a transaction object must implement a transaction object with this interface (various fields can be null):

```js
{
    address: // address of the destination, never null
    amount: // the value of the amount (if stellar, value is in stellar), not null
    currency: // the type of currency, null for STR
    issuer: // the issuing currency, if null and currency is not null, will be stellar account
    txblob: // the signed binary form of the payment transaction, null until signing
    txhash: // the hash of the signed transaction, null until signing
    sequence: // the sequence number this transaction was signed with, null until signing
}
```

### Transaction States

We can model a transaction's lifecycle from creation to confirmation or error as a state machine.

<img src="https://cloud.githubusercontent.com/assets/993607/5421333/b4dc1648-8216-11e4-8553-e014a6a26b5c.png" alt="Drawing" style="width: 400px;"/>

##### Unsigned
An unsigned transaction is a simple address/amount pair. It is the state a transaction is in when it is first created.

##### Signed
A signed transaction is a transaction that has been signed but not submitted. It has an associated txblob (signed form of the transaction), a txhash, and a sequence number. A signed transaction can be submitted to the network.

##### Submitted
A submitted transaction has been successfully submitted to the network, though it is not necessarily applied to a ledger or a valid transaction. Submitted transactions will continue to be submitted to the network until they are confirmed or errored.

##### Confirmed
A transaction reaches the confirmation state when it has been confirmed into a validated ledger. This is a terminal state, a confirmed transaction will always be confirmed.

##### Error
A transaction reaches an error state when signing or submitting returns an error which is not expected. There are two types of errors: fatal and non-fatal. Non-fatal errors will not cause processing to halt, processing will continue onto the next transaction (after potentially resigning transactions in the case of a resign error) and simple mark the transaction as "errored". A fatal error causes all processing to stop and requires manual intervention to proceed.

##### Aborted
An aborted transaction is a transaction that has errored and has been manually acknowledged as "ignore". A fatal error transaction can be sent to the abort state to resume transaction processing.

### Modules

Stellar Payments provides a sensible default implementation for signing and submitting, persisting transactions, and logging. However, the library is modular and abstracts these various components, allowing the consumer of the library to provide their own implementations at runtime (through the Payments config object). Here's a specification/interface for each module you can provide.

##### Errors
Each module specific error must be inherited from Error by requiring lib/errors.js in the module. Additionally, each error should live in a static 'errors' object, which itself should be a static property of the module export. For instance, the module Signer exports its constructor function Signer(). And each error lives in Signer.errors, for example, Signer.errors.SigningError. See the code for clarity.

#### Database Module

The database module is responsible for persisting transaction meta information. It it used extensively throughout the library to: persist signed transaction blobs, query for transactions in different states, manipulate transaction state, and retrieve information about state of the transaction datastore, among others. You can provide your own implementation of the database module interface when instantiating the Payment object. Here's the interface:

##### ```getUnsignedTransactions(limit)```
Returns transactions that are in the Unsigned state up to the limit.

##### ```markTransactionError(transaction, error, isFatal)```
Puts the given transaction into the Error state and mark the transaction with the given error. If isFatal is true, this transaction will cause processing to stop, and further calls to Payments.processPayments() will check if this error has been moved to the aborted state.

##### ```storeSignedTransaction(transaction)```
Persist the given transaction to the database.

##### ```getSubmittedUnconfirmedTransactions()```
Return all transactions in the submitted state.

##### ```getSignedUnconfirmedTransactions()```
Return all transactions in the signed or submitted state.

##### ```getUnsubmittedTransactions()```
Return all transactions in the unsigned state.

##### ```markTransactionSubmitted(transaction)```
Move the given transaction to the submitted state.

##### ```markTransactionConfirmed()```
Move the given transaction to the confirmed state.

##### ```getHighestSequenceNumberFromTransactions()```
Return the highest sequence number from a signed transaction, null if no signed transactions.

##### ```clearSignedTransactionsFromId(id)```
Any transaction that has an 'id' > the given id should be moved to the unsigned state.

##### ```isAborted(transaction)```
Returns true if the given transaction is aborted, false otherwise.

#### Signer Module

The signers job is simple: set a local sequence number, then get all unsigned transactions and sign them, incrementing the local sequence number each time, persisting the txblob and txhash to the db. Here's the interface:

##### ```Signer(config, database, network)```
Constructs a signer object with the given config as well as database and network modules.

##### ```setSequenceNumber(sequence)```
Set the local sequence number to the given sequence number.

##### ```getSequenceNumber()```
Return the current sequence number.

##### ```signTransactions(limit)```
Retrieve transactions in the unsigned state from the database (up to the given limit).

##### Errors
* Signer.errors.SigningError
    Returned during a signing error. This transaction should be moved to the non-fatal error state, and signing should continue.

#### Network Module
The network module provides the interface to the Stellar Network. IMPORTANT: the return objects from the Stellar Websocket API and the HTTP API are different. Each call to the network module expects the JSON response body from the HTTP API. Here's the interface:

##### ```submitTransactionBlob(txblob)```
Submits the given txblob to the network. Returns the JSON response body.

##### ```getTransaction(txhash)```
Fetches the transaction with the given hash from the network. Returns the JSON response body.

##### ```getAccountInfo(address)```
Fetches the account info for the given address. Returns the JSON response body.

##### Errors
* StellarNetwork.errors.NetworkError
    Thrown if there is a network error, or if stellar returns an error code in the JSON response body. This will be caught in Payments.js, logged, and ignored.

#### Submitter Module
The submitter is the most complex module, and the included implementation should be relied on in most cases.

// TODO

##### Errors
See lib/submitter.js for a complete list of errors.
