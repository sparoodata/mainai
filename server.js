// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const path = require('path');
const multer = require('multer');
const AWS = require('aws-sdk');

const app = express();
const port = process.env.PORT || 3000;

const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  region: 'auto',
  signatureVersion: 'v4',
});

mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 3600000 },
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const { Image, UploadToken, Property, Unit, Tenant } = require('./models');
const { router: webhookRouter, sendMessage } = require('./routes/webhook');
app.use('/webhook', webhookRouter);

async function validateUploadToken(req, res, next) {
  const token = req.method === 'GET' ? req.query.token : req.body.token;
  const uploadToken = await UploadToken.findOne({ token });
  if (!uploadToken || uploadToken.used || new Date() > uploadToken.expiresAt) return res.status(403).send('Invalid or expired token.');
  req.uploadToken = uploadToken;
  next();
}

app.get('/upload-image/:phoneNumber/:type/:id', validateUploadToken, (req, res) => {
  res.render('uploadImage', { ...req.params, token: req.query.token });
});

app.post('/upload-image/:phoneNumber/:type/:id', upload.single('image'), validateUploadToken, async (req, res) => {
  try {
    const { phoneNumber, type, id } = req.params;
    const key = `images/${Date.now()}-${req.file.originalname}`;
    await s3.upload({ Bucket: process.env.R2_BUCKET, Key: key, Body: req.file.buffer, ContentType: req.file.mimetype }).promise();
    const imageUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
    const image = await new Image({ [`${type}Id`]: id, imageUrl }).save();

    let entity;
    if (type === 'property') entity = await Property.findByIdAndUpdate(id, { $push: { images: image._id } }, { new: true });
    if (type === 'unit') entity = await Unit.findByIdAndUpdate(id, { $push: { images: image._id } }, { new: true });
    if (type === 'tenant') entity = await Tenant.findByIdAndUpdate(id, { photo: imageUrl }, { new: true });

    req.uploadToken.used = true;
    await req.uploadToken.save();

    await sendMessage(phoneNumber, `✅ Image uploaded successfully for ${type} "${entity.name || entity.unitNumber}".`);
    res.send('Image uploaded successfully!');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error uploading image.');
  }
});

app.listen(port, () => console.log(`Server running at http://localhost:${port}`));


// webhook.js
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { Property, Unit, Tenant, User, UploadToken } = require('../models');
const router = express.Router();

const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

function generateId(prefix) {
  const digits = Math.floor(1000 + Math.random() * 9000);
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `${prefix}${digits}${letter}`;
}

async function sendMessage(phoneNumber, message) {
  await axios.post(WHATSAPP_API_URL, {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'text',
    text: { body: message },
  }, { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
}

async function generateUploadToken(phoneNumber, type, entityId) {
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  const uploadToken = new UploadToken({ token, phoneNumber, type, entityId, expiresAt });
  await uploadToken.save();
  return token;
}

async function sendSummary(phoneNumber, type, entityId) {
  let entity;
  if (type === 'property') entity = await Property.findById(entityId).populate('images');
  if (type === 'unit') entity = await Unit.findById(entityId).populate('images');
  if (type === 'tenant') entity = await Tenant.findById(entityId);
  const imageUrl = entity.images?.[0]?.imageUrl || entity.photo || 'https://via.placeholder.com/150';
  const summary = `📸 *Image*: \n${imageUrl}\n✅ *${type.charAt(0).toUpperCase() + type.slice(1)} Summary*\n━━━━━━━━━━━━━━━\n*Name*: ${entity.name || entity.unitNumber}`;
  await sendMessage(phoneNumber, summary);
}

router.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object === 'whatsapp_business_account') {
    const message = body.entry[0].changes[0].value.messages?.[0];
    const phoneNumber = `+${message?.from}`;
    if (message?.interactive?.button_reply?.id?.startsWith('upload_')) {
      const [_, type, id] = message.interactive.button_reply.id.split('_');
      const token = await generateUploadToken(phoneNumber, type, id);
      await sendMessage(phoneNumber, `Please upload image: ${process.env.GLITCH_HOST}/upload-image/${phoneNumber}/${type}/${id}?token=${token}`);
    }
  }
  res.sendStatus(200);
});

module.exports = { router, sendMessage };
