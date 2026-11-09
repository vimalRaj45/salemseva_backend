/**
 * 24-Hour Pre-Service Cancellation Policy Engine
 * Enforces that self-service cancellations are only permissible
 * at least 24 hours before the scheduled service appointment.
 */

/**
 * Parses appointment date & time from scheduled slot and calculates
 * hours remaining until service delivery.
 *
 * @param {string} scheduledSlot e.g. '2026-11-10 10:00 AM - 12:00 PM', 'Tomorrow, 10:00 AM'
 * @param {Date|string} [createdAt]
 * @param {boolean} [isUrgentDispatch=false]
 * @param {Date} [now=new Date()]
 * @param {boolean} [isTechAssigned=true]
 * @returns {{
 *   isCancellationAllowed: boolean,
 *   hoursRemaining: number,
 *   appointmentDate: Date,
 *   policyReason: string
 * }}
 */
function checkCancellationWindow(scheduledSlot, createdAt, isUrgentDispatch = false, now = new Date(), isTechAssigned = true) {
  const currentMs = now.getTime();
  const createdDate = createdAt ? new Date(createdAt) : now;
  const slotStr = String(scheduledSlot || '').trim();
  const lowerSlot = slotStr.toLowerCase();

  // 1. If no technician has been assigned yet (created / matching stage), customer can freely cancel
  if (!isTechAssigned) {
    return {
      isCancellationAllowed: true,
      hoursRemaining: 999,
      appointmentDate: new Date(),
      policyReason: 'Technician has not yet been assigned. Free cancellation is permitted prior to specialist assignment.'
    };
  }

  // 2. Emergency / Immediate Dispatch bookings are on-demand within 1-2 hours
  if (isUrgentDispatch || lowerSlot.includes('emergency') || lowerSlot.includes('urgent')) {
    const immediateServiceTime = new Date(createdDate.getTime() + 60 * 60 * 1000); // 1 hour from creation
    const hoursRemaining = (immediateServiceTime.getTime() - currentMs) / (1000 * 60 * 60);

    return {
      isCancellationAllowed: false,
      hoursRemaining: Math.max(0, parseFloat(hoursRemaining.toFixed(1))),
      appointmentDate: immediateServiceTime,
      policyReason: 'Emergency and immediate dispatch bookings have already mobilized on-duty technicians and are not eligible for self-service cancellation within 24 hours of service.'
    };
  }

  // 2. Parse Date
  let targetYear = now.getFullYear();
  let targetMonth = now.getMonth();
  let targetDay = now.getDate();

  const isoDateMatch = slotStr.match(/\b(202\d)-(\d{2})-(\d{2})\b/);
  if (isoDateMatch) {
    targetYear = parseInt(isoDateMatch[1], 10);
    targetMonth = parseInt(isoDateMatch[2], 10) - 1;
    targetDay = parseInt(isoDateMatch[3], 10);
  } else if (lowerSlot.includes('tomorrow')) {
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    targetYear = tomorrow.getFullYear();
    targetMonth = tomorrow.getMonth();
    targetDay = tomorrow.getDate();
  } else if (lowerSlot.includes('today')) {
    targetYear = now.getFullYear();
    targetMonth = now.getMonth();
    targetDay = now.getDate();
  }

  // 3. Parse Time (e.g. '10:00 AM', '02:30 PM', '2:00 PM')
  let targetHours = 10; // Default morning slot 10:00 AM
  let targetMinutes = 0;

  const timeMatch = slotStr.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (timeMatch) {
    let rawHours = parseInt(timeMatch[1], 10);
    targetMinutes = parseInt(timeMatch[2], 10);
    const meridiem = (timeMatch[3] || '').toUpperCase();

    if (meridiem === 'PM' && rawHours < 12) {
      rawHours += 12;
    } else if (meridiem === 'AM' && rawHours === 12) {
      rawHours = 0;
    }
    targetHours = rawHours;
  }

  const appointmentDate = new Date(targetYear, targetMonth, targetDay, targetHours, targetMinutes, 0, 0);
  const diffMs = appointmentDate.getTime() - currentMs;
  const hoursRemaining = diffMs / (1000 * 60 * 60);

  // Cancellation must be requested at least 24.0 hours before appointment
  const isCancellationAllowed = hoursRemaining >= 24.0;

  let policyReason = '';
  if (isCancellationAllowed) {
    policyReason = `Cancellation is available because your appointment is scheduled ${hoursRemaining.toFixed(1)} hours in advance (exceeds the 24-hour cutoff).`;
  } else {
    policyReason = `Cancellation is unavailable because your appointment is scheduled in ${Math.max(0, hoursRemaining).toFixed(1)} hours. Under Shazu One policy, cancellations must be made at least 24 hours prior to service.`;
  }

  return {
    isCancellationAllowed,
    hoursRemaining: parseFloat(hoursRemaining.toFixed(1)),
    appointmentDate,
    policyReason
  };
}

module.exports = {
  checkCancellationWindow
};
