const mongoose = require('mongoose');
const { CUSTOMER_STATUS, CUSTOMER_STATUS_VALUES } = require('../config/constants');

const customerSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Customer name is required'],
    trim: true,
    maxlength: [120, 'Name cannot exceed 120 characters'],
  },
  email: {
    type: String,
    required: [true, 'Customer email is required'],
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
  },
  phone: {
    type: String,
    trim: true,
    default: '',
  },
  company: {
    type: String,
    trim: true,
    default: '',
  },
  // Not in the original model list, but the natural-language search feature is
  // specified with a location example ("customers in Karachi ..."), so a city
  // field is needed for that query to mean anything.
  city: {
    type: String,
    trim: true,
    default: '',
  },
  status: {
    type: String,
    enum: {
      values: CUSTOMER_STATUS_VALUES,
      message: `Status must be one of: ${CUSTOMER_STATUS_VALUES.join(', ')}`,
    },
    default: CUSTOMER_STATUS.LEAD,
  },
  notes: {
    type: String,
    trim: true,
    default: '',
    maxlength: [2000, 'Notes cannot exceed 2000 characters'],
  },
  // The sales rep responsible for this customer.
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  // Who added the record. Needed for the sales_rep permission rule, which
  // grants access to customers they *created* or are *assigned to*.
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Text index powers the keyword fallback used by the AI search endpoint.
customerSchema.index({ name: 'text', email: 'text', company: 'text', notes: 'text' });
// The two filters the customer list screen hits on nearly every request.
customerSchema.index({ status: 1, assignedTo: 1 });

module.exports = mongoose.model('Customer', customerSchema);
