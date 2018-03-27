const Request = require("request-promise");
const Joi = require("joi");
const Bitcore = require("bitcore-lib");
const helper = require("../app").helper;

module.exports = (app) => {

    app.post("/withdraw", (request, response) => {
        var model = Joi.object().keys({
            satoshis: Joi.number().required(),
            id: Joi.string().required()
        });
        Joi.validate(request.body, model, { stripUnknown: true }, (error, value) => {
            if(error) {
                return response.status(500).send(error);
            }
            helper.getAccountBalance(value.id).then(result => {
                if(result.balance == null || (result.balance - value.satoshis) < 0) {
                    return response.status(500).send({ "message": "There are not `" + value.satoshis + "` satoshis available for withdrawal" });
                }
                Request("https://api.coinmarketcap.com/v1/ticker/bitcoin/").then(market => {
                    var usd = (Bitcore.Unit.fromSatoshis(value.satoshis).toBTC() * JSON.parse(market)[0].price_usd).toFixed(2);
                    var transaction = {
                        account: value.id,
                        satoshis: (value.satoshis * -1),
                        usd: parseFloat(usd),
                        timestamp: (new Date()).getTime(),
                        status: "withdrawal",
                        type: "transaction"
                    };
                    helper.insert(transaction).then(result => {
                        response.send(result);
                    }, error => {
                        response.status(500).send(error);
                    });
                }, error => {
                    response.status(500).send(error);
                });
            }, error => {
                return response.status(500).send(error);
            });
        });
    });

    app.post("/deposit", (request, response) => {
        var model = Joi.object().keys({
            usd: Joi.number().required(),
            id: Joi.string().required()
        });
        Joi.validate(request.body, model, { stripUnknown: true }, (error, value) => {
            if(error) {
                return response.status(500).send(error);
            }
            Request("https://api.coinmarketcap.com/v1/ticker/bitcoin/").then(market => {
                var btc = value.usd / JSON.parse(market)[0].price_usd;
                var transaction = {
                    account: value.id,
                    usd: value.usd,
                    satoshis: Bitcore.Unit.fromBTC(btc).toSatoshis(),
                    timestamp: (new Date()).getTime(),
                    status: "deposit",
                    type: "transaction"
                };
                helper.insert(transaction).then(result => {
                    response.send(result);
                }, error => {
                    response.status(500).send(error);
                });
            }, error => {
                response.status(500).send(error);
            });
        });
    });

    app.post("/transfer", (request, response) => {
        var model = Joi.object().keys({
            amount: Joi.number().required(),
            sourceaddress: Joi.string().optional(),
            destinationaddress: Joi.string().required(),
            id: Joi.string().required()
        });
        Joi.validate(request.body, model, { stripUnknown: true }, (error, value) => {
            if(error) {
                return response.status(500).send(error);
            }
            if(value.sourceaddress) {
                helper.createTransactionFromAccount(value.id, value.sourceaddress, value.destinationaddress, value.amount).then(result => {
                    response.send(result);
                }, error => {
                    response.status(500).send(error);
                });
            } else {
                helper.createTransactionFromMaster(value.id, value.destinationaddress, value.amount).then(result => {
                    response.send(result);
                }, error => {
                    response.status(500).send(error);
                });
            }
        });
    });

}
