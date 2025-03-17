const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const Groq = require('groq-sdk');

const User = require('../models/User');
const Property = require('../models/Property');
const Unit = require('../models/Unit');
const Tenant = require('../models/Tenant');
const UploadToken = require('../models/UploadToken');

const router = express.Router();

const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const GLITCH_HOST = process.env.GLITCH_HOST;
const DEFAULT_IMAGE_URL = 'https://via.placeholder.com/150';

const sessions = {};
let userResponses = {};

// Helpers and validators
const chunkArray = require('../helpers/chunkArray');
const { isValidName, isValidAddress, isValidUnits, isValidTotalAmount, isValidDate } = require('../helpers/validators');
const { generateUnitId, generateTenantId } = require('../helpers/idGenerators');
const { shortenUrl, sendMessage, sendImageMessage, sendImageOption } = require('../helpers/whatsapp');
const generateUploadToken = require('../helpers/uploadToken');
const menuHelpers = require('../helpers/menuHelpers');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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

      // (If using text-based numeric selection for chunked lists, handle it here.)

      // ======== Extended Add-Property Flow ========
      if (text) {
        if (sessions[fromNumber].action === 'add_property_name') {
          if (isValidName(text)) {
            sessions[fromNumber].propertyData = { name: text };
            await sendMessage(
              fromNumber,
              '📝 *Description* \nPlease provide a description for the property.'
            );
            sessions[fromNumber].action = 'add_property_description';
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid entry* \nPlease retry with a valid property name (max 40 characters, no special characters).'
            );
          }
        } else if (sessions[fromNumber].action === 'add_property_description') {
          sessions[fromNumber].propertyData.description = text;
          await sendMessage(
            fromNumber,
            '📍 *Street Address* \nPlease provide the street address of the property.'
          );
          sessions[fromNumber].action = 'add_property_address';
        } else if (sessions[fromNumber].action === 'add_property_address') {
          if (isValidAddress(text)) {
            sessions[fromNumber].propertyData.address = text;
            await sendMessage(fromNumber, '🏙️ *City* \nEnter the city.');
            sessions[fromNumber].action = 'add_property_city';
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid entry* \nPlease retry with a valid street address.'
            );
          }
        } else if (sessions[fromNumber].action === 'add_property_city') {
          sessions[fromNumber].propertyData.city = text;
          await sendMessage(fromNumber, '🌆 *State* \nEnter the state.');
          sessions[fromNumber].action = 'add_property_state';
        } else if (sessions[fromNumber].action === 'add_property_state') {
          sessions[fromNumber].propertyData.state = text;
          await sendMessage(fromNumber, '📮 *ZIP Code* \nEnter the ZIP code.');
          sessions[fromNumber].action = 'add_property_zip';
        } else if (sessions[fromNumber].action === 'add_property_zip') {
          sessions[fromNumber].propertyData.zipCode = text;
          await sendMessage(fromNumber, '🌍 *Country* \nEnter the country.');
          sessions[fromNumber].action = 'add_property_country';
        } else if (sessions[fromNumber].action === 'add_property_country') {
          sessions[fromNumber].propertyData.country = text;
          await sendMessage(fromNumber, '🏢 *Property Type* \nEnter the property type (e.g., Apartment, Condo).');
          sessions[fromNumber].action = 'add_property_type';
        } else if (sessions[fromNumber].action === 'add_property_type') {
          sessions[fromNumber].propertyData.propertyType = text;
          await sendMessage(fromNumber, '🏗️ *Year Built* \nEnter the year the property was built.');
          sessions[fromNumber].action = 'add_property_yearBuilt';
        } else if (sessions[fromNumber].action === 'add_property_yearBuilt') {
          const year = parseInt(text);
          if (!isNaN(year)) {
            sessions[fromNumber].propertyData.yearBuilt = year;
            await sendMessage(fromNumber, '🏠 *Total Units* \nEnter the total number of units.');
            sessions[fromNumber].action = 'add_property_totalUnits';
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid entry* \nPlease enter a valid year.');
          }
        } else if (sessions[fromNumber].action === 'add_property_totalUnits') {
          if (isValidUnits(text)) {
            sessions[fromNumber].propertyData.totalUnits = parseInt(text);
            await sendMessage(fromNumber, '💰 *Purchase Price* \nEnter the purchase price.');
            sessions[fromNumber].action = 'add_property_purchasePrice';
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid entry* \nPlease enter a valid number of units (a positive integer).'
            );
          }
        } else if (sessions[fromNumber].action === 'add_property_purchasePrice') {
          if (!isNaN(parseFloat(text)) && parseFloat(text) > 0) {
            sessions[fromNumber].propertyData.purchasePrice = parseFloat(text);
            // Create the property using the extended data
            const user = await User.findOne({ phoneNumber });
            const property = new Property({
              name: sessions[fromNumber].propertyData.name,
              description: sessions[fromNumber].propertyData.description,
              address: sessions[fromNumber].propertyData.address,
              city: sessions[fromNumber].propertyData.city,
              state: sessions[fromNumber].propertyData.state,
              zipCode: sessions[fromNumber].propertyData.zipCode,
              country: sessions[fromNumber].propertyData.country,
              propertyType: sessions[fromNumber].propertyData.propertyType,
              yearBuilt: sessions[fromNumber].propertyData.yearBuilt,
              totalUnits: sessions[fromNumber].propertyData.totalUnits,
              purchasePrice: sessions[fromNumber].propertyData.purchasePrice,
              ownerId: user._id,
            });
            await property.save();

            sessions[fromNumber].entityType = 'property';
            sessions[fromNumber].entityId = property._id;
            await sendImageOption(fromNumber, 'property', property._id);
            sessions[fromNumber].action = 'awaiting_image_choice';
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid entry* \nPlease enter a valid purchase price.');
          }
        }
        // ======== Add-Unit Flow (unchanged) ========
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
            await sendMessage(fromNumber, '⚠️ *Invalid entry* \nPlease provide a valid rent amount.');
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
        // ======== Extended Add-Tenant Flow ========
        else if (sessions[fromNumber].action === 'add_tenant_fullName') {
          // Instead of overwriting tenantData, add the fullName property.
          if (!sessions[fromNumber].tenantData) {
            sessions[fromNumber].tenantData = {};
          }
          sessions[fromNumber].tenantData.fullName = text;
          await sendMessage(
            fromNumber,
            '📅 *Lease Start Date* \nWhen does the lease start? (e.g., DD-MM-YYYY)'
          );
          sessions[fromNumber].action = 'add_tenant_leaseStartDate';
        } else if (sessions[fromNumber].action === 'add_tenant_leaseStartDate') {
          if (isValidDate(text)) {
            sessions[fromNumber].tenantData.leaseStartDate = text;
            await sendMessage(
              fromNumber,
              '💵 *Deposit Amount* \nWhat is the deposit amount?'
            );
            sessions[fromNumber].action = 'add_tenant_depositAmount';
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid Date* \nPlease use DD-MM-YYYY format (e.g., 01-01-2025).'
            );
          }
        } else if (sessions[fromNumber].action === 'add_tenant_depositAmount') {
          const deposit = parseFloat(text);
          if (!isNaN(deposit) && deposit > 0) {
            sessions[fromNumber].tenantData.depositAmount = deposit;
            await sendMessage(
              fromNumber,
              '💰 *Monthly Rent* \nWhat is the monthly rent amount?'
            );
            sessions[fromNumber].action = 'add_tenant_monthlyRent';
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid entry* \nPlease provide a valid deposit amount.'
            );
          }
        } else if (sessions[fromNumber].action === 'add_tenant_monthlyRent') {
          const rent = parseFloat(text);
          if (!isNaN(rent) && rent > 0) {
            // Before creating the tenant, ensure that a unit has been selected.
            if (!sessions[fromNumber].tenantData.unitAssigned) {
              await sendMessage(
                fromNumber,
                '⚠️ *Error:* Unit not selected. Please select a valid unit for the tenant.'
              );
              // Optionally, set action back to unit selection if needed.
              sessions[fromNumber].action = 'add_tenant_select_unit';
              return res.sendStatus(200);
            }
            const user = await User.findOne({ phoneNumber });
            const tenant = new Tenant({
              fullName: sessions[fromNumber].tenantData.fullName,
              phoneNumber: user.phoneNumber,
              userId: user._id,
              propertyName: sessions[fromNumber].tenantData.propertyName,
              unitAssigned: sessions[fromNumber].tenantData.unitAssigned,
              leaseStartDate: sessions[fromNumber].tenantData.leaseStartDate,
              depositAmount: sessions[fromNumber].tenantData.depositAmount,
              monthlyRent: rent,
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
              '⚠️ *Invalid entry* \nPlease provide a valid monthly rent amount.'
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
          const properties = await Property.find({ ownerId: user._id });
          if (!properties.length) {
            await sendMessage(
              fromNumber,
              'ℹ️ *No Properties* \nPlease add a property first.'
            );
          } else {
            sessions[fromNumber].properties = properties;
            sessions[fromNumber].userId = user._id;
            await menuHelpers.sendPropertySelectionMenu(fromNumber, properties);
            sessions[fromNumber].action = 'add_unit_select_property';
          }
        } else if (selectedOption === 'add_tenant') {
          const user = await User.findOne({ phoneNumber });
          const properties = await Property.find({ ownerId: user._id });
          if (!properties.length) {
            await sendMessage(
              fromNumber,
              'ℹ️ *No Properties* \nPlease add a property first.'
            );
          } else {
            sessions[fromNumber].properties = properties;
            sessions[fromNumber].userId = user._id;
            await menuHelpers.sendPropertySelectionMenu(fromNumber, properties);
            sessions[fromNumber].action = 'add_tenant_select_property';
          }
        }
        // Handle property selection from chunked lists (for adding a Unit)
        else if (sessions[fromNumber].action === 'add_unit_select_property') {
          if (selectedOption.startsWith('chunk')) {
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
        // Handle property selection from chunked lists (for adding a Tenant)
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
        // Handle unit selection from chunked lists (for adding a Tenant)
        else if (sessions[fromNumber].action === 'add_tenant_select_unit') {
          if (selectedOption.startsWith('chunk')) {
            const [chunkTag, unitId] = selectedOption.split('_');
            const foundUnit = await Unit.findById(unitId).populate('property');
            if (foundUnit) {
              sessions[fromNumber].tenantData.unitAssigned = foundUnit._id;
              sessions[fromNumber].tenantData.propertyName = foundUnit.property.name;
              await sendMessage(
                fromNumber,
                '👤 *Tenant Full Name* \nPlease provide the tenant’s full name.'
              );
              sessions[fromNumber].action = 'add_tenant_fullName';
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
              await sendSummary(fromNumber, 'property', entityId, DEFAULT_IMAGE_URL);
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

// Sends a summary message as both an image message (with caption) and a text message
async function sendSummary(phoneNumber, type, entityId, imageUrl) {
  let caption;
  if (type === 'property') {
    const property = await Property.findById(entityId);
    caption = `✅ *Property Added*\n━━━━━━━━━━━━━━━\n🏠 *Name*: ${property.name}\n📝 *Description*: ${property.description}\n📍 *Address*: ${property.address}, ${property.city}, ${property.state} ${property.zipCode}, ${property.country}\n🏢 *Type*: ${property.propertyType}\n🏗️ *Year Built*: ${property.yearBuilt}\n🏠 *Total Units*: ${property.totalUnits}\n💰 *Purchase Price*: ${property.purchasePrice}\n━━━━━━━━━━━━━━━`;
  } else if (type === 'unit') {
    const unit = await Unit.findById(entityId).populate('property');
    caption = `✅ *Unit Added*\n━━━━━━━━━━━━━━━\n🏠 *Property*: ${unit.property.name}\n🚪 *Unit ID*: ${unit.unitNumber}\n💰 *Rent Amount*: ${unit.rentAmount}\n📏 *Floor*: ${unit.floor}\n📐 *Size*: ${unit.size}\n━━━━━━━━━━━━━━━`;
  } else if (type === 'tenant') {
    const tenant = await Tenant.findById(entityId);
    const unit = await Unit.findById(tenant.unitAssigned);
    caption = `✅ *Tenant Added*\n━━━━━━━━━━━━━━━\n👤 *Name*: ${tenant.fullName}\n🏠 *Property*: ${tenant.propertyName}\n🚪 *Unit*: ${unit ? unit.unitNumber : 'N/A'}\n📅 *Lease Start*: ${new Date(tenant.leaseStartDate).toLocaleDateString()}\n💵 *Deposit*: ${tenant.depositAmount}\n💰 *Monthly Rent*: ${tenant.monthlyRent}\n━━━━━━━━━━━━━━━`;
  }
  await sendImageMessage(phoneNumber, imageUrl, caption);
  await sendMessage(phoneNumber, caption);
}

module.exports = {
  router,
  sendMessage,
  sendSummary,
};
