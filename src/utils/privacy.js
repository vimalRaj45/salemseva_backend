/**
 * Shazu One Privacy & Telephony Guard
 * Manages stage-gated phone number visibility, masking, and E.164 dialer formatting.
 */

const HELPDESK_PHONE = '+918807099277';

const ACTIVE_DIRECT_CALL_STATUSES = new Set([
  'matching',
  'accepted',
  'en_route',
  'arrived',
  'inspecting',
  'quote_presented',
  'quote_approved',
  'in_progress'
]);

function canDirectCall(status) {
  if (!status) return false;
  return ACTIVE_DIRECT_CALL_STATUSES.has(String(status).toLowerCase().trim());
}

function sanitizePhoneForDialer(phone) {
  if (!phone) return HELPDESK_PHONE;
  const digitsOnly = String(phone).replace(/\D/g, '');
  if (!digitsOnly) return HELPDESK_PHONE;
  if (digitsOnly.length === 10) {
    return `+91${digitsOnly}`;
  }
  if (digitsOnly.length > 10 && digitsOnly.startsWith('91')) {
    return `+${digitsOnly}`;
  }
  return `+${digitsOnly}`;
}

function maskPhoneNumber(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 6) return '******';
  const last10 = digits.slice(-10);
  const prefix = last10.slice(0, 2);
  const suffix = last10.slice(-2);
  return `+91 ${prefix}*** ***${suffix}`;
}

function redactBookingParties(booking, options = {}) {
  if (!booking) return booking;
  const isAdmin = Boolean(options.isAdmin);
  const status = booking.status;

  if (isAdmin || canDirectCall(status)) {
    return {
      ...booking,
      canDirectCall: true,
      helpdeskPhone: HELPDESK_PHONE
    };
  }

  // Redact / mask for completed or cancelled bookings
  return {
    ...booking,
    customer_phone: maskPhoneNumber(booking.customer_phone),
    technician_phone: maskPhoneNumber(booking.technician_phone),
    canDirectCall: false,
    helpdeskPhone: HELPDESK_PHONE
  };
}

module.exports = {
  HELPDESK_PHONE,
  ACTIVE_DIRECT_CALL_STATUSES,
  canDirectCall,
  sanitizePhoneForDialer,
  maskPhoneNumber,
  redactBookingParties
};
