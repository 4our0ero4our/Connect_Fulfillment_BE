/**
 * Generates a unique support ticket number.
 * 
 * Format: TKT-YYYY-XXXXXX
 * Where YYYY is the current year and XXXXXX is a 6-digit sequential number.
 * 
 * @returns {Promise<string>} Unique ticket number
 */
export const generateTicketNumber = async (): Promise<string> => {
  const year = new Date().getFullYear();
  const random = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
  return `TKT-${year}-${random}`;
};

