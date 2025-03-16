const express = require('express');
const axios = require('axios');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const Property = require('../models/Property');
const Unit = require('../models/Unit');
const UploadToken = require('../models/UploadToken');
const Groq = require('groq-sdk');
const crypto = require('crypto');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const router = express.Router();

const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const GLITCH_HOST = process.env.GLITCH_HOST;
const DEFAULT_IMAGE_URL = 'https://via.placeholder.com/150';

const sessions = {};
let userResponses = {};

const chunkArray = require('../helpers/chunkArray');
const { isValidName, isValidAddress, isValidUnits, isValidTotalAmount, isValidDate } = require('../helpers/validators');
const { generateUnitId, generateTenantId } = require('../helpers/idGenerators');
const { shortenUrl, sendMessage, sendImageMessage, sendImageOption } = require('../helpers/whatsapp');
const generateUploadToken = require('../helpers/uploadToken');
const menuHelpers = require('../helpers/menuHelpers');

// Helper: Check if a string is numeric
function isNumeric(value) {
  return /^-?\d+$/.test(value);
}

// GET for webhook verification
router.get('/', (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified successfully');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Main webhook POST handler
router.post('/', async (req, res) => {
  const body = req.body;

  if (body.object === 'whatsapp_business_account') {
    const entry = body.entry[0];
    const changes = entry.changes[0];
    const value = changes.value;

    // Capture contact info
    if (value.contacts) {
      const contact = value.contacts[0];
      const contactPhoneNumber = `+${contact.wa_id}`;
      const profileName = contact.profile.name;
      const user =
        (await User.findOne({ phoneNumber: contactPhoneNumber })) ||
        new User({ phoneNumber: contactPhoneNumber });
      user.profileName = profileName || user.profileName;
      await user.save();
    }

    // Capture messages
    if (value.messages) {
      const message = value.messages[0];
      const fromNumber = message.from;
      const phoneNumber = `+${fromNumber}`;
      const text = message.text ? message.text.body.trim() : null;
      const interactive = message.interactive || null;

      console.log(`Message from ${fromNumber}:`, { text, interactive });

      // Capture interactive replies
      if (interactive && interactive.type === 'list_reply') {
        userResponses[fromNumber] = interactive.list_reply.id;
        console.log(`List reply received: ${userResponses[fromNumber]}`);
      } else if (interactive && interactive.type === 'button_reply') {
        userResponses[fromNumber] = interactive.button_reply.id;
        console.log(`Button reply received: ${userResponses[fromNumber]}`);
      }

      if (!sessions[fromNumber]) {
        sessions[fromNumber] = { action: null };
      }

      // Handle numeric responses (if we revert to numeric selection flows)
      if (
        text &&
        sessions[fromNumber].action &&
        (sessions[fromNumber].action === 'add_unit_select_property' ||
          sessions[fromNumber].action === 'add_tenant_select_property' ||
          sessions[fromNumber].action === 'add_tenant_select_unit')
      ) {
        // If we used text-based numeric selection, we’d handle it here.
        // Currently, we are using chunked interactive lists, so we might not rely on this.
      }

      // ======== Add-Property Flow ========
      if (text) {
        if (sessions[fromNumber].action === 'add_property_name') {
          if (isValidName(text)) {
            sessions[fromNumber].propertyData = { name: text };
            await sendMessage(
              fromNumber,
              '📍 *Property Address* \nPlease provide the address of the property.'
            );
            sessions[fromNumber].action = 'add_property_address';
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid entry* \nPlease retry with a valid property name (e.g., "Sunset Apartments"). Max 40 characters, no special characters.'
            );
          }
        } else if (sessions[fromNumber].action === 'add_property_address') {
          if (isValidAddress(text)) {
            sessions[fromNumber].propertyData.address = text;
            await sendMessage(
              fromNumber,
              '🏠 *Number of Units* \nHow many units does this property have? (e.g., 5)'
            );
            sessions[fromNumber].action = 'add_property_units';
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid entry* \nPlease retry with a valid address (e.g., "123 Main St"). Max 40 characters, no special characters.'
            );
          }
        } else if (sessions[fromNumber].action === 'add_property_units') {
          if (isValidUnits(text)) {
            sessions[fromNumber].propertyData.units = parseInt(text);
            await sendMessage(
              fromNumber,
              '💰 *Total Amount* \nWhat is the total amount for this property (e.g., 5000)?'
            );
            sessions[fromNumber].action = 'add_property_totalAmount';
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid entry* \nPlease retry with a valid number of units (e.g., 5). Must be a positive whole number.'
            );
          }
        } else if (sessions[fromNumber].action === 'add_property_totalAmount') {
          if (isValidTotalAmount(text)) {
            const user = await User.findOne({ phoneNumber });
            const property = new Property({
              name: sessions[fromNumber].propertyData.name,
              address: sessions[fromNumber].propertyData.address,
              units: sessions[fromNumber].propertyData.units,
              totalAmount: parseFloat(text),
              userId: user._id,
            });
            await property.save();

            sessions[fromNumber].entityType = 'property';
            sessions[fromNumber].entityId = property._id;
            await sendImageOption(fromNumber, 'property', property._id);
            sessions[fromNumber].action = 'awaiting_image_choice';
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid entry* \nPlease retry with a valid total amount (e.g., 5000). Must be a positive number.'
            );
          }
        }
        // ======== Add-Unit Flow ========
        else if (sessions[fromNumber].action === 'add_unit_rent') {
          const rent = parseFloat(text);
          if (!isNaN(rent) && rent > 0) {
            sessions[fromNumber].unitData.rentAmount = rent;
            await sendMessage(
              fromNumber,
              '📏 *Floor* \nWhich floor is this unit on? (e.g., 1, Ground)'
            );
            sessions[fromNumber].action = 'add_unit_floor';
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid entry* \nPlease provide a valid rent amount.'
            );
          }
        } else if (sessions[fromNumber].action === 'add_unit_floor') {
          sessions[fromNumber].unitData.floor = text;
          await sendMessage(
            fromNumber,
            '📐 *Size* \nWhat is the size of this unit (e.g., 500 sq ft)?'
          );
          sessions[fromNumber].action = 'add_unit_size';
        } else if (sessions[fromNumber].action === 'add_unit_size') {
          const user = await User.findOne({ phoneNumber });
          const unit = new Unit({
            property: sessions[fromNumber].unitData.property,
            unitNumber: sessions[fromNumber].unitData.unitNumber, // auto-generated earlier
            rentAmount: sessions[fromNumber].unitData.rentAmount,
            floor: sessions[fromNumber].unitData.floor,
            size: text,
            userId: user._id,
          });
          await unit.save();
          sessions[fromNumber].entityType = 'unit';
          sessions[fromNumber].entityId = unit._id;
          await sendImageOption(fromNumber, 'unit', unit._id);
          sessions[fromNumber].action = 'awaiting_image_choice';
        }
        // ======== Add-Tenant Flow ========
        else if (sessions[fromNumber].action === 'add_tenant_name') {
          sessions[fromNumber].tenantData.name = text;
          await sendMessage(
            fromNumber,
            '📅 *Lease Start Date* \nWhen does the lease start? (e.g., DD-MM-YYYY like 01-01-2025)'
          );
          sessions[fromNumber].action = 'add_tenant_lease_start';
        } else if (sessions[fromNumber].action === 'add_tenant_lease_start') {
          if (isValidDate(text)) {
            sessions[fromNumber].tenantData.lease_start = text;
            await sendMessage(
              fromNumber,
              '💵 *Deposit* \nWhat is the deposit amount?'
            );
            sessions[fromNumber].action = 'add_tenant_deposit';
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid Date* \nPlease use DD-MM-YYYY format (e.g., 01-01-2025).'
            );
          }
        } else if (sessions[fromNumber].action === 'add_tenant_deposit') {
          const deposit = parseFloat(text);
          if (!isNaN(deposit) && deposit > 0) {
            sessions[fromNumber].tenantData.deposit = deposit;
            await sendMessage(
              fromNumber,
              '💰 *Rent Amount* \nWhat is the monthly rent amount?'
            );
            sessions[fromNumber].action = 'add_tenant_rent';
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid entry* \nPlease provide a valid deposit amount.'
            );
          }
        } else if (sessions[fromNumber].action === 'add_tenant_rent') {
          const rent = parseFloat(text);
          if (!isNaN(rent) && rent > 0) {
            const user = await User.findOne({ phoneNumber });
            const tenant = new Tenant({
              name: sessions[fromNumber].tenantData.name,
              phoneNumber: user.phoneNumber,
              userId: user._id,
              propertyName: sessions[fromNumber].tenantData.propertyName,
              unitAssigned: sessions[fromNumber].tenantData.unitAssigned,
              lease_start: sessions[fromNumber].tenantData.lease_start,
              deposit: sessions[fromNumber].tenantData.deposit,
              rent_amount: rent,
              tenant_id: generateTenantId(),
            });
            await tenant.save();
            sessions[fromNumber].entityType = 'tenant';
            sessions[fromNumber].entityId = tenant._id;
            await sendImageOption(fromNumber, 'tenant', tenant._id);
            sessions[fromNumber].action = 'awaiting_image_choice';
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid entry* \nPlease provide a valid rent amount.'
            );
          }
        }
        // ========== “Help” Flow ==========
        else if (text.toLowerCase() === 'help') {
          const buttonMenu = {
            messaging_product: 'whatsapp',
            to: fromNumber,
            type: 'interactive',
            interactive: {
              type: 'button',
              header: { type: 'text', text: '🏠 Rental Management' },
              body: { text: '*Welcome!* Please select an option below:' },
              footer: { text: 'Powered by Your Rental App' },
              action: {
                buttons: [
                  {
                    type: 'reply',
                    reply: { id: 'account_info', title: '👤 Account Info' },
                  },
                  { type: 'reply', reply: { id: 'manage', title: '🛠️ Manage' } },
                  { type: 'reply', reply: { id: 'tools', title: '🧰 Tools' } },
                ],
              },
            },
          };
          await axios.post(WHATSAPP_API_URL, buttonMenu, {
            headers: {
              Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
          });
        }
      }

      // Handle interactive replies (button or list)
      if (interactive && userResponses[fromNumber]) {
        const selectedOption = userResponses[fromNumber];

        if (selectedOption === 'account_info') {
          const user = await User.findOne({ phoneNumber });
          const accountInfoMessage = user
            ? `
*👤 Account Information*
━━━━━━━━━━━━━━━
📞 *Phone*: ${user.phoneNumber}
✅ *Verified*: ${user.verified ? 'Yes' : 'No'}
🧑 *Profile Name*: ${user.profileName || 'N/A'}
📅 *Registration Date*: ${
                user.registrationDate
                  ? user.registrationDate.toLocaleDateString()
                  : 'N/A'
              }
💰 *Subscription*: ${user.subscription}
━━━━━━━━━━━━━━━
          `
            : '⚠️ *No Account Found* \nNo account information is available for this number.';
          await sendMessage(fromNumber, accountInfoMessage);
        } else if (selectedOption === 'manage') {
          await menuHelpers.sendManageSubmenu(fromNumber);
        } else if (selectedOption === 'tools') {
          await menuHelpers.sendToolsSubmenu(fromNumber);
        } else if (selectedOption === 'manage_properties') {
          await menuHelpers.sendPropertyOptions(fromNumber);
        } else if (selectedOption === 'manage_units') {
          await menuHelpers.sendUnitOptions(fromNumber);
        } else if (selectedOption === 'manage_tenants') {
          await menuHelpers.sendTenantOptions(fromNumber);
        } else if (selectedOption === 'add_property') {
          await sendMessage(
            fromNumber,
            '🏠 *Add Property* \nLet’s start! Please provide the property name.'
          );
          sessions[fromNumber].action = 'add_property_name';
        } else if (selectedOption === 'add_unit') {
          const user = await User.findOne({ phoneNumber });
          const properties = await Property.find({ userId: user._id });
          if (!properties.length) {
            await sendMessage(
              fromNumber,
              'ℹ️ *No Properties* \nPlease add a property first.'
            );
          } else {
            sessions[fromNumber].properties = properties;
            sessions[fromNumber].userId = user._id;
            // Now we send chunked interactive lists of properties:
            await menuHelpers.sendPropertySelectionMenu(fromNumber, properties);
            sessions[fromNumber].action = 'add_unit_select_property';
          }
        } else if (selectedOption === 'add_tenant') {
          const user = await User.findOne({ phoneNumber });
          const properties = await Property.find({ userId: user._id });
          if (!properties.length) {
            await sendMessage(
              fromNumber,
              'ℹ️ *No Properties* \nPlease add a property first.'
            );
          } else {
            sessions[fromNumber].properties = properties;
            sessions[fromNumber].userId = user._id;
            // Now we send chunked interactive lists of properties:
            await menuHelpers.sendPropertySelectionMenu(fromNumber, properties);
            sessions[fromNumber].action = 'add_tenant_select_property';
          }
        }
        // Handle property selection from chunked lists (for adding a Unit):
        else if (sessions[fromNumber].action === 'add_unit_select_property') {
          // The incoming selectedOption might look like: "chunk0_<propertyId>"
          if (selectedOption.startsWith('chunk')) {
            // Parse out the propertyId
            const [chunkTag, propertyId] = selectedOption.split('_');
            const foundProperty = await Property.findById(propertyId);
            if (foundProperty) {
              sessions[fromNumber].unitData = { property: foundProperty._id };
              sessions[fromNumber].unitData.unitNumber = generateUnitId();
              await sendMessage(
                fromNumber,
                `Unit ID generated: ${sessions[fromNumber].unitData.unitNumber}. Please provide the rent amount for this unit.`
              );
              sessions[fromNumber].action = 'add_unit_rent';
            } else {
              await sendMessage(
                fromNumber,
                '⚠️ *Invalid Selection* \nPlease select a valid property.'
              );
            }
          }
        }
        // Handle property selection from chunked lists (for adding a Tenant):
        else if (sessions[fromNumber].action === 'add_tenant_select_property') {
          if (selectedOption.startsWith('chunk')) {
            const [chunkTag, propertyId] = selectedOption.split('_');
            const foundProperty = await Property.findById(propertyId);
            if (foundProperty) {
              sessions[fromNumber].tenantData = {
                propertyId: foundProperty._id,
                propertyName: foundProperty.name,
              };
              const units = await Unit.find({ property: foundProperty._id });
              if (!units.length) {
                await sendMessage(
                  fromNumber,
                  'ℹ️ *No Units* \nPlease add a unit to this property first.'
                );
                sessions[fromNumber].action = null;
                delete sessions[fromNumber].tenantData;
              } else {
                await menuHelpers.sendUnitSelectionMenu(fromNumber, units);
                sessions[fromNumber].action = 'add_tenant_select_unit';
              }
            } else {
              await sendMessage(
                fromNumber,
                '⚠️ *Invalid Selection* \nPlease select a valid property.'
              );
            }
          }
        }
        // Handle unit selection from chunked lists (for adding a Tenant):
        else if (sessions[fromNumber].action === 'add_tenant_select_unit') {
          if (selectedOption.startsWith('chunk')) {
            const [chunkTag, unitId] = selectedOption.split('_');
            const foundUnit = await Unit.findById(unitId).populate('property');
            if (foundUnit) {
              sessions[fromNumber].tenantData.unitAssigned = foundUnit._id;
              sessions[fromNumber].tenantData.propertyName =
                foundUnit.property.name;
              await sendMessage(
                fromNumber,
                '👤 *Tenant Name* \nPlease provide the tenant’s full name.'
              );
              sessions[fromNumber].action = 'add_tenant_name';
            } else {
              await sendMessage(
                fromNumber,
                '⚠️ *Invalid Selection* \nPlease select a valid unit.'
              );
            }
          }
        }
        // Handle image upload choice
        else if (sessions[fromNumber].action === 'awaiting_image_choice') {
          if (selectedOption.startsWith('upload_')) {
            const [, type, entityId] = selectedOption.split('_');
            const token = await generateUploadToken(phoneNumber, type, entityId);
            const imageUploadUrl = `${GLITCH_HOST}/upload-image/${phoneNumber}/${type}/${entityId}?token=${token}`;
            const shortUrl = await shortenUrl(imageUploadUrl);
            await sendMessage(
              fromNumber,
              `Please upload the image here (valid for 15 minutes): ${shortUrl}`
            );
            sessions[fromNumber].action = null;
            delete sessions[fromNumber].entityType;
            delete sessions[fromNumber].entityId;
          } else if (selectedOption.startsWith('no_upload_')) {
            const [, type, entityId] = selectedOption.split('_');
            if (type === 'property') {
              const property = await Property.findById(entityId);
              property.images.push(DEFAULT_IMAGE_URL);
              await property.save();
              await sendSummary(
                fromNumber,
                'property',
                entityId,
                DEFAULT_IMAGE_URL
              );
            } else if (type === 'unit') {
              const unit = await Unit.findById(entityId);
              unit.images.push(DEFAULT_IMAGE_URL);
              await unit.save();
              await sendSummary(fromNumber, 'unit', entityId, DEFAULT_IMAGE_URL);
            } else if (type === 'tenant') {
              const tenant = await Tenant.findById(entityId);
              tenant.photo = DEFAULT_IMAGE_URL;
              await tenant.save();
              await sendSummary(fromNumber, 'tenant', entityId, DEFAULT_IMAGE_URL);
            }
            sessions[fromNumber].action = null;
            delete sessions[fromNumber].entityType;
            delete sessions[fromNumber].entityId;
          }
        }
        // Clear the user response so it doesn't interfere later
        delete userResponses[fromNumber];
      }
    }
  }
  res.sendStatus(200);
});

// Sends a summary message as both an image message (with caption) and a separate text message
async function sendSummary(phoneNumber, type, entityId, imageUrl) {
  let caption;
  if (type === 'property') {
    const property = await Property.findById(entityId);
    caption = `✅ *Property Added*\n━━━━━━━━━━━━━━━\n🏠 *Name*: ${property.name}\n📍 *Address*: ${property.address}\n🚪 *Units*: ${property.units}\n💰 *Total Amount*: ${property.totalAmount}\n━━━━━━━━━━━━━━━`;
  } else if (type === 'unit') {
    const unit = await Unit.findById(entityId).populate('property');
    caption = `✅ *Unit Added*\n━━━━━━━━━━━━━━━\n🏠 *Property*: ${unit.property.name}\n🚪 *Unit ID*: ${unit.unitNumber}\n💰 *Rent Amount*: ${unit.rentAmount}\n📏 *Floor*: ${unit.floor}\n📐 *Size*: ${unit.size}\n━━━━━━━━━━━━━━━`;
  } else if (type === 'tenant') {
    const tenant = await Tenant.findById(entityId);
    const unit = await Unit.findById(tenant.unitAssigned);
    caption = `✅ *Tenant Added*\n━━━━━━━━━━━━━━━\n👤 *Name*: ${tenant.name}\n🏠 *Property*: ${tenant.propertyName}\n🚪 *Unit*: ${
      unit ? unit.unitNumber : 'N/A'
    }\n📅 *Lease Start*: ${tenant.lease_start}\n💵 *Deposit*: ${
      tenant.deposit
    }\n💰 *Rent Amount*: ${tenant.rent_amount}\n━━━━━━━━━━━━━━━`;
  }
  // First try to send the image message with caption
  await sendImageMessage(phoneNumber, imageUrl, caption);
  // Also send a text message so the summary is clearly visible
  await sendMessage(phoneNumber, caption);
}

module.exports = {
  router,
  sendMessage,
  sendSummary,
};
