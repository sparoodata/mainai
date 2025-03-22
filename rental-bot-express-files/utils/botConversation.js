const mongoose = require('mongoose');
const Property = require('../models/Property');
const Unit = require('../models/Unit');
const Tenant = require('../models/Tenant');
const helpers = require('./helpers');
const zepMemory = require('./zepMemory');

/**
 * Bot conversation state manager for multi-step interactions
 */
class BotConversationManager {
  constructor() {
    // Store conversation states by userId
    this.conversationStates = new Map();
    
    // Define conversation flows
    this.flows = {
      ADD_PROPERTY: {
        steps: ['name', 'address', 'type', 'size'],
        questions: {
          name: "What's the name of the property?",
          address: "What's the address of the property?",
          type: "What type of property is it? (Apartment, House, Condo, Commercial, or Other)",
          size: "What's the size of the property in square feet?"
        },
        validator: this.validatePropertyInput
      },
      ADD_UNIT: {
        steps: ['property', 'floor', 'rent', 'isAvailable'],
        questions: {
          property: "Which property would you like to add this unit to?",
          floor: "What floor is this unit on?",
          rent: "What is the monthly rent for this unit?",
          isAvailable: "Is this unit currently available for rent? (yes/no)"
        },
        validator: this.validateUnitInput
      },
      ADD_TENANT: {
        steps: ['unit', 'name', 'email', 'phone', 'moveInDate', 'rentAmount', 'rentDueDate'],
        questions: {
          unit: "Which unit will this tenant occupy?",
          name: "What is the tenant's full name?",
          email: "What is the tenant's email address?",
          phone: "What is the tenant's phone number?",
          moveInDate: "What is the tenant's move-in date? (YYYY-MM-DD)",
          rentAmount: "What is the monthly rent amount?",
          rentDueDate: "What day of the month is rent due? (1-31)"
        },
        validator: this.validateTenantInput
      }
    };
  }
  
  /**
   * Get current conversation state for a user
   * @param {string} userId - User identifier
   * @returns {Object|null} Current conversation state or null if none exists
   */
  getState(userId) {
    return this.conversationStates.get(userId) || null;
  }
  
  /**
   * Start a new conversation flow
   * @param {string} userId - User identifier
   * @param {string} flowType - Type of flow to start (ADD_PROPERTY, ADD_UNIT, ADD_TENANT)
   * @param {Object} initialData - Initial data for the flow (optional)
   * @returns {string} Next question to ask
   */
  startFlow(userId, flowType, initialData = {}) {
    if (!this.flows[flowType]) {
      throw new Error(`Invalid flow type: ${flowType}`);
    }
    
    const flow = this.flows[flowType];
    const state = {
      flowType,
      currentStep: 0,
      data: initialData,
      completed: false
    };
    
    this.conversationStates.set(userId, state);
    
    // If we already have data for the first step, move to the next step
    if (initialData[flow.steps[0]]) {
      return this.processNextStep(userId, initialData[flow.steps[0]]);
    }
    
    return flow.questions[flow.steps[0]];
  }
  
  /**
   * Process user input for the current step and move to the next step
   * @param {string} userId - User identifier
   * @param {string} input - User input for the current step
   * @returns {string} Next question to ask or completion message
   */
  processNextStep(userId, input) {
    const state = this.getState(userId);
    
    if (!state) {
      return "I'm not sure what you're referring to. You can start by adding a property, unit, or tenant.";
    }
    
    const flow = this.flows[state.flowType];
    const currentStepName = flow.steps[state.currentStep];
    
    // Validate input for current step
    const validationResult = flow.validator(currentStepName, input);
    if (!validationResult.valid) {
      return validationResult.message;
    }
    
    // Store validated data
    state.data[currentStepName] = validationResult.value;
    
    // Move to next step
    state.currentStep++;
    
    // Check if we've completed all steps
    if (state.currentStep >= flow.steps.length) {
      state.completed = true;
      return this.completeFlow(userId);
    }
    
    // Get next question
    const nextStepName = flow.steps[state.currentStep];
    return flow.questions[nextStepName];
  }
  
  /**
   * Complete the current flow and save data
   * @param {string} userId - User identifier
   * @returns {Promise<string>} Completion message
   */
  async completeFlow(userId) {
    const state = this.getState(userId);
    
    if (!state || !state.completed) {
      return "There's no active conversation to complete.";
    }
    
    try {
      let result;
      
      switch (state.flowType) {
        case 'ADD_PROPERTY':
          result = await this.saveProperty(state.data);
          break;
        case 'ADD_UNIT':
          result = await this.saveUnit(state.data);
          break;
        case 'ADD_TENANT':
          result = await this.saveTenant(state.data);
          break;
        default:
          throw new Error(`Unknown flow type: ${state.flowType}`);
      }
      
      // Clear conversation state
      this.conversationStates.delete(userId);
      
      return result;
    } catch (error) {
      console.error(`Error completing flow ${state.flowType}:`, error);
      return `I encountered an error while saving your information: ${error.message}. Please try again.`;
    }
  }
  
  /**
   * Cancel the current flow
   * @param {string} userId - User identifier
   * @returns {string} Cancellation message
   */
  cancelFlow(userId) {
    const hadState = this.conversationStates.has(userId);
    this.conversationStates.delete(userId);
    
    return hadState 
      ? "I've cancelled the current operation. How else can I help you?"
      : "There's no active operation to cancel.";
  }
  
  /**
   * Check if user input indicates cancellation
   * @param {string} input - User input
   * @returns {boolean} Whether input indicates cancellation
   */
  isCancellationRequest(input) {
    const lowerInput = input.toLowerCase().trim();
    return ['cancel', 'stop', 'quit', 'exit', 'nevermind'].includes(lowerInput);
  }
  
  /**
   * Process user message within conversation context
   * @param {string} userId - User identifier
   * @param {string} message - User message
   * @returns {Promise<string|null>} Response message or null if not handled
   */
  async processMessage(userId, message) {
    // Check for cancellation request
    if (this.isCancellationRequest(message)) {
      return this.cancelFlow(userId);
    }
    
    const state = this.getState(userId);
    
    // If no active conversation, return null to let regular processing handle it
    if (!state) {
      return null;
    }
    
    // Process the message as input for the current step
    const response = this.processNextStep(userId, message);
    
    // Save the conversation step to memory
    await zepMemory.addMemory(userId, response, false);
    
    return response;
  }
  
  /**
   * Validate property input
   * @param {string} field - Field name
   * @param {string} input - User input
   * @returns {Object} Validation result
   */
  validatePropertyInput(field, input) {
    const trimmedInput = input.trim();
    
    switch (field) {
      case 'name':
        if (trimmedInput.length < 2) {
          return { valid: false, message: "Property name is too short. Please provide a longer name." };
        }
        return { valid: true, value: trimmedInput };
        
      case 'address':
        if (trimmedInput.length < 5) {
          return { valid: false, message: "Please provide a complete address." };
        }
        return { valid: true, value: trimmedInput };
        
      case 'type':
        const validTypes = ['apartment', 'house', 'condo', 'commercial', 'other'];
        const lowerType = trimmedInput.toLowerCase();
        
        if (!validTypes.includes(lowerType)) {
          return { 
            valid: false, 
            message: "Please select a valid property type: Apartment, House, Condo, Commercial, or Other." 
          };
        }
        
        // Capitalize first letter
        const formattedType = lowerType.charAt(0).toUpperCase() + lowerType.slice(1);
        return { valid: true, value: formattedType };
        
      case 'size':
        const size = parseInt(trimmedInput.replace(/[^0-9]/g, ''), 10);
        
        if (isNaN(size) || size <= 0) {
          return { valid: false, message: "Please provide a valid size in square feet (a positive number)." };
        }
        
        return { valid: true, value: size };
        
      default:
        return { valid: false, message: `Unknown property field: ${field}` };
    }
  }
  
  /**
   * Validate unit input
   * @param {string} field - Field name
   * @param {string} input - User input
   * @returns {Object} Validation result
   */
  validateUnitInput(field, input) {
    const trimmedInput = input.trim();
    
    switch (field) {
      case 'property':
        // This could be a property ID or a selection from a list
        // For simplicity, we'll assume it's a valid property ID or index
        return { valid: true, value: trimmedInput };
        
      case 'floor':
        const floor = trimmedInput;
        
        if (floor.length === 0) {
          return { valid: false, message: "Please provide a valid floor number or identifier." };
        }
        
        return { valid: true, value: floor };
        
      case 'rent':
        // Remove any non-numeric characters except decimal point
        const rentStr = trimmedInput.replace(/[^0-9.]/g, '');
        const rent = parseFloat(rentStr);
        
        if (isNaN(rent) || rent <= 0) {
          return { valid: false, message: "Please provide a valid rent amount (a positive number)." };
        }
        
        return { valid: true, value: rent };
        
      case 'isAvailable':
        const lowerAvailable = trimmedInput.toLowerCase();
        const isAvailable = ['yes', 'y', 'true', 'available', '1'].includes(lowerAvailable);
        
        return { valid: true, value: isAvailable };
        
      default:
        return { valid: false, message: `Unknown unit field: ${field}` };
    }
  }
  
  /**
   * Validate tenant input
   * @param {string} field - Field name
   * @param {string} input - User input
   * @returns {Object} Validation result
   */
  validateTenantInput(field, input) {
    const trimmedInput = input.trim();
    
    switch (field) {
      case 'unit':
        // This could be a unit ID or a selection from a list
        // For simplicity, we'll assume it's a valid unit ID or index
        return { valid: true, value: trimmedInput };
        
      case 'name':
        if (trimmedInput.length < 2) {
          return { valid: false, message: "Tenant name is too short. Please provide a full name." };
        }
        return { valid: true, value: trimmedInput };
        
      case 'email':
        // Simple email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(trimmedInput) && trimmedInput !== '') {
          return { valid: false, message: "Please provide a valid email address or leave it blank." };
        }
        return { valid: true, value: trimmedInput };
        
      case 'phone':
        // Simple phone validation - allow empty
        const phoneRegex = /^[0-9()\-\s+]*$/;
        if (!phoneRegex.test(trimmedInput)) {
          return { valid: false, message: "Please provide a valid phone number or leave it blank." };
        }
        return { valid: true, value: trimmedInput };
        
      case 'moveInDate':
        // Date validation
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(trimmedInput)) {
          return { valid: false, message: "Please provide a valid move-in date in YYYY-MM-DD format." };
        }
        
        const date = new Date(trimmedInput);
        if (isNaN(date.getTime())) {
          return { valid: false, message: "Please provide a valid move-in date." };
        }
        
        return { valid: true, value: trimmedInput };
        
      case 'rentAmount':
        // Remove any non-numeric characters except decimal point
        const rentStr = trimmedInput.replace(/[^0-9.]/g, '');
        const rent = parseFloat(rentStr);
        
        if (isNaN(rent) || rent <= 0) {
          return { valid: false, message: "Please provide a valid rent amount (a positive number)." };
        }
        
        return { valid: true, value: rent };
        
      case 'rentDueDate':
        const dueDate = parseInt(trimmedInput, 10);
        
        if (isNaN(dueDate) || dueDate < 1 || dueDate > 31) {
          return { valid: false, message: "Please provide a valid day of the month (1-31)." };
        }
        
        return { valid: true, value: dueDate };
        
      default:
        return { valid: false, message: `Unknown tenant field: ${field}` };
    }
  }
  
  /**
   * Save property to database
   * @param {Object} data - Property data
   * @returns {Promise<string>} Success message
   */
  async saveProperty(data) {
    try {
      // Create new property
      const property = new Property({
        name: data.name,
        address: data.address,
        type: data.type,
        size: data.size,
        owner: data.owner || '000000000000000000000000' // Placeholder owner ID
      });
      
      await property.save();
      
      return `Great! I've added the property "${data.name}" to your account. You can now add units to this property by saying "add unit".`;
    } catch (error) {
      console.error('Error saving property:', error);
      throw new Error(`Failed to save property: ${error.message}`);
    }
  }
  
  /**
   * Save unit to database
   * @param {Object} data - Unit data
   * @returns {Promise<string>} Success message
   */
  async saveUnit(data) {
    try {
      // Handle property selection (could be index or ID)
      let propertyId = data.property;
      
      // If it's a number (index from list), get the actual property
      if (/^\d+$/.test(data.property)) {
        const index = parseInt(data.property, 10) - 1;
        const properties = await Property.find({}).sort({ name: 1 });
        
        if (index < 0 || index >= properties.length) {
          throw new Error('Invalid property selection');
        }
        
        propertyId = properties[index]._id;
      }
      
      // Generate unique unitId
      const unitId = helpers.generateUnitId();
      
      // Create new unit
      const unit = new Unit({
        unitId,
        property: propertyId,
        floor: data.floor,
        rent: data.rent,
        isAvailable: data.isAvailable
      });
      
      await unit.save();
      
      return `Great! I've added unit ${unitId} to your property. This unit is on floor ${data.floor} with a monthly rent of $${data.rent} and is currently ${data.isAvailable ? 'available' : 'not available'} for rent.`;
    } catch (error) {
      console.error('Error saving unit:', error);
      throw new Error(`Failed to save unit: ${error.message}`);
    }
  }
  
  /**
   * Save tenant to database
   * @param {Object} data - Tenant data
   * @returns {Promise<string>} Success message
   */
  async saveTenant(data) {
    try {
      // Handle unit selection (could be index or ID)
      let unitId = data.unit;
      let unit;
      
      // If it's a number (index from list), get the actual unit
      if (/^\d+$/.test(data.unit)) {
        const index = parseInt(data.unit, 10) - 1;
        const units = await Unit.find({ isAvailable: true }).sort({ unitId: 1 });
        
        if (index < 0 || index >= units.length) {
          throw new Error('Invalid unit selection');
        }
        
        unit = units[index];
        unitId = unit._id;
      } else {
        // Find unit by unitId
        unit = await Unit.findOne({ unitId: data.unit });
        
        if (!unit) {
          throw new Error(`Unit ${data.unit} not found`);
        }
        
        unitId = unit._id;
      }
      
      // Generate unique tenantId
      const tenantId = helpers.generateTenantId();
      
      // Create new tenant
      const tenant = new Tenant({
        tenantId,
        name: data.name,
        contact: {
          email: data.email,
          phone: data.phone
        },
        unit: unitId,
        moveInDate: new Date(data.moveInDate),
        rentInfo: {
          amount: data.rentAmount,
          dueDate: data.rentDueDate,
          paymentHistory: []
        }
      });
      
      await tenant.save();
      
      // Update unit availability
      await Unit.findByIdAndUpdate(unitId, { isAvailable: false });
      
      return `Great! I've added ${data.name} as a tenant for unit ${unit.unitId}. The tenant ID is ${tenantId}. The move-in date is set to ${data.moveInDate} with a monthly rent of $${data.rentAmount} due on day ${data.rentDueDate} of each month.`;
    } catch (error) {
      console.error('Error saving tenant:', error);
      throw new Error(`Failed to save tenant: ${error.message}`);
    }
  }
}

module.exports = new BotConversationManager();
