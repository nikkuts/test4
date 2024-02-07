const axios = require('axios');
const Base64 = require('crypto-js/enc-base64');
const SHA1 = require('crypto-js/sha1');
const Utf8 = require('crypto-js/enc-utf8');
const { v4: uuidv4 } = require('uuid');
const {User} = require('../models/user');
const {Payment} = require('../models/payment');
const {HttpError, ctrlWrapper, handleIndicators} = require('../helpers');
require('dotenv').config();

const PUBLIC_KEY = process.env.PUBLIC_KEY_TEST;
const PRIVATE_KEY = process.env.PRIVATE_KEY_TEST;
const {BASE_CLIENT_URL, BASE_SERVER_URL} = process.env;
const MAIN_ID = process.env.MAIN_ID;

const createPayment = async (req, res) => {
    const {_id} = req.user;
    const {amount, comment, subscribe} = req.body;
    const orderId = uuidv4();

    const dataObj = {
      public_key: PUBLIC_KEY, 
      version: '3',
      action: 'pay',
      amount: amount,
      currency: 'UAH',
      description: 'Підтримка проєкту "Єдині": безповоротний благодійний внесок',
      order_id: orderId,
      result_url: BASE_CLIENT_URL,
      server_url: `${BASE_SERVER_URL}/api/payments/process`,
      customer: _id,
    };

    if (comment) {
      dataObj.info = comment;
    }

    if (subscribe) {
      const currentTimeUtc = new Date().toISOString();
      const formattedTimeUtc = currentTimeUtc.replace('T', ' ').substring(0, 19);
      dataObj.action = 'subscribe';
      dataObj.subscribe = subscribe;
      dataObj.subscribe_date_start = formattedTimeUtc;
      dataObj.subscribe_periodicity = 'month';
    }

    // Кодуємо дані JSON у рядок та потім у Base64
    const dataString = JSON.stringify(dataObj);
    const data = Base64.stringify(Utf8.parse(dataString));

    // Створюємо підпис
    const hash = SHA1(PRIVATE_KEY + data + PRIVATE_KEY);
    const signature = Base64.stringify(hash);

    res.json({
      data,
      signature,
    })
};

const deleteSubscribe = async (req, res) => {
  const {_id} = req.user;
    const {orderId} = req.body;

    const payment = await Payment.findOne({
      'data.order_id': orderId,
      'data.status': 'subscribed'
    });

    if (payment.data.customer !== _id) {
      throw HttpError(409, "Підписка не належить користувачеві");
    } 

    const dataObj = {
      public_key: PUBLIC_KEY, 
      version: '3',
      action: 'unsubscribe',
      order_id: orderId,
    };

    // Кодуємо дані JSON у рядок та потім у Base64
    const dataString = JSON.stringify(dataObj);
    const data = Base64.stringify(Utf8.parse(dataString));

    // Створюємо підпис
    const hash = SHA1(PRIVATE_KEY + data + PRIVATE_KEY);
    const signature = Base64.stringify(hash);

    const responseLiqpay = await axios.post("https://www.liqpay.ua/api/request", {data, signature});
    console.log(responseLiqpay);

    res.json({
      data,
      signature,
    })
};

const distributesBonuses = async ({id, email, amount, paymentId}) => {
  let inviterId = id;
  let bonus = amount * 0.45;
  let bonusAccount;
  let historyBonusAccount;
  let userId;
  let levelPartner = 0;
  let levelBonus;
  let levelSupport;
  let fee;

  for (let i = 1; i <= 8; i += 1) {
    levelBonus = i;       
      do {
          const user = await User.findById(inviterId)
          .populate('donats', 'data.amount');
        
          userId = user._id.toString();
          bonusAccount = user.bonusAccount;
          historyBonusAccount = {
            initialBalance: user.bonusAccount,
            comment: "бонус",
            levelBonus,
            emailPartner: email,
          };

          inviterId = user.inviter;
          levelPartner += 1;
          levelSupport = handleIndicators(user).levelSupport;

          if (userId === MAIN_ID) {
              bonusAccount += bonus;

              await User.findByIdAndUpdate(MAIN_ID, {
                $set: {bonusAccount}, 
                $push: {
                  historyBonusAccount: {
                    ...historyBonusAccount,
                  finalBalance: bonusAccount,
                  amountTransaction: bonus,
                  }
                }
              });
              
              await Payment.findByIdAndUpdate(paymentId, { 
                $push: { 
                  fees: {
                    userId,
                    levelPartner,
                    levelBonus,
                    levelSupport,
                    fee: bonus,
                  } 
                } 
              });
              return console.log({ success: true, message: 'Головний акаунт досягнуто' });
          }
      } while (levelSupport < i);

      fee = i === 1 
          ? amount * 0.1
          : amount * 0.05;

      bonusAccount += fee;
          
      await User.findByIdAndUpdate(userId, {
        $set: {bonusAccount}, 
          $push: {
            historyBonusAccount: {
              ...historyBonusAccount,
              finalBalance: bonusAccount,
              amountTransaction: fee,
            }
          }
        });

      bonus = bonus - fee;

      await Payment.findByIdAndUpdate(paymentId, { 
        $push: { 
          fees: {
            userId,
            levelPartner,
            levelBonus,
            levelSupport,
            fee,
          } 
        } 
      });

      if (bonus === 0) {
          return console.log({ success: true, message: 'Бонус повністю розподілено' });
      }
      if (bonus < 0) {
        return console.log({ success: false, message: 'Розподілено більше допустимої суми бонусу' });
      }
  };
  console.log({ success: false, message: 'Бонус не було розподілено' });
  throw HttpError(409, "Бонус не було розподілено");
};

const processesPayment = async (req, res) => {
    const {data, signature} = req.body;
    const hash = SHA1(PRIVATE_KEY + data + PRIVATE_KEY);
    const sign = Base64.stringify(hash);

    if (sign !== signature) {
      throw HttpError(400, "Несправжня відповідь LiqPay");
    }

    const dataString = Utf8.stringify(Base64.parse(data));
    const result = JSON.parse(dataString);

    const {order_id, status, customer, amount} = result;
    const payment = await Payment.findOne({
      'data.order_id': order_id,
      status
    });

    if (payment) {
      throw HttpError(409, "Платіж вже існує");
    } 
    
    const newPayment = await Payment.create({data: result});

    if (status === 'subscribed') {
      await User.findByIdAndUpdate(
        customer, 
        { $push: { subscribes: newPayment._id } }
      );
    }

    if (status === 'success') {
      const user = await User.findByIdAndUpdate(
        customer, 
        { $push: { donats: newPayment._id } },
        { new: true }
      );

      if (customer !== MAIN_ID) {
        await distributesBonuses ({
          id: user.inviter, 
          email: user.email, 
          amount,
          paymentId: newPayment._id.toString(),
        });
      }
    }

    res.status(200).json({
      message: 'success',
  })
};

module.exports = {
    createPayment: ctrlWrapper(createPayment),
    deleteSubscribe: ctrlWrapper(deleteSubscribe),
    processesPayment: ctrlWrapper(processesPayment),
};


// const distributesBonuses = async (id, amount) => {
//   let inviterId = id; 
//   let bonus = amount * 0.45;
//   let userId;
//   let bonusAccount;
//   let level;
//   let fee;

//   for (let i = 1; i <= 8; i += 1) {       
//       do {
//           const user = await User.findById(inviterId)
//           .populate('donats', 'data.amount');
        
//           userId = user._id.toString();

//           if (userId === MAIN_ID) {
//               bonusAccount = user.bonusAccount + bonus;
//               await User.findByIdAndUpdate(MAIN_ID, {bonusAccount});
//               return console.log({ success: true, message: 'Головний акаунт досягнуто' });
//           }

//           inviterId = user.inviter;
//           bonusAccount = user.bonusAccount;
//           level = levelSupport(user);
//       } while (level < i);

//       fee = i === 1 
//           ? amount * 0.1
//           : amount * 0.05;

//           bonusAccount = bonusAccount + fee;
          
//       await User.findByIdAndUpdate(userId, {bonusAccount});
//       bonus = bonus - fee;

//       if (bonus === 0) {
//           return console.log({ success: true, message: 'Бонус повністю розподілено' });
//       }
//       if (bonus < 0) {
//         return console.log({ success: false, message: 'Розподілено більше допустимої суми бонусу' });
//       }
//   };
//   return console.log({ success: false, message: 'Бонус не було розподілено' });
// };