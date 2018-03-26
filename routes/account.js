const Request = require("request-promise");
const Joi = require("joi");
const helper = require("../app").helper;

module.exports = (app) => {

    app.post("/account", (request, response) => {
        var model = Joi.object().keys({
            firstname: Joi.string().required(),
            lastname: Joi.string().required(),
            type: Joi.string().forbidden().default("account")
        });
        Joi.validate(request.body, model, { stripUnknown: true }, (error, value) => {
            if(error) {
                return response.status(500).send(error);
            }
            helper.createAccount(value).then(result => {
                response.send(value);
            }, error => {
                response.status(500).send(error);
            });
        });
    });

    app.put("/account/address/:id", (request, response) => {
        helper.addAddress(request.params.id).then(result => {
            response.send(result);
        }, error => {
            return response.status(500).send(error);
        });
    });

    app.get("/account/addresses/:id", (request, response) => {
        helper.getAddresses(request.params.id).then(result => {
            response.send(result);
        }, error => {
            response.status(500).send(error);
        });
    });

    app.get("/addresses", (request, response) => {
        helper.getAddresses().then(result => {
            response.send(result);
        }, error => {
            response.status(500).send(error);
        });
    });

    app.get("/account/balance/:id", (request, response) => {
        helper.getAddresses(request.params.id).then(addresses => helper.getWalletBalance(addresses)).then(balance => {
            helper.getAccountBalance(request.params.id).then(result => {
                response.send({ "balance": balance.balance + result.balance });
            }, error => {
                response.status(500).send({ "code": error.code, "message": error.message });
            });
        }, error => {
            response.status(500).send({ "code": error.code, "message": error.message });
        });
    });

}
