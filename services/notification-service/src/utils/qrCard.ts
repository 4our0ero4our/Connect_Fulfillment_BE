import { createCanvas, loadImage, SKRSContext2D } from '@napi-rs/canvas';
import QRCode from 'qrcode';

interface TicketCardOptions {
  ticketId: string;
  orderNumber?: string;
  companyName: string;
  customerEmail: string;
  status: string;
  qrPayload: string;
}

const WIDTH = 640;
const HEIGHT = 820;

export const generateTicketCard = async ({
  ticketId,
  orderNumber,
  companyName,
  customerEmail,
  status,
  qrPayload,
}: TicketCardOptions) => {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  gradient.addColorStop(0, '#0f172a');
  gradient.addColorStop(1, '#1e3a8a');

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.fillStyle = '#ffffff';
  ctx.font = '700 30px "Segoe UI", Arial';
  ctx.fillText(companyName, 40, 70);

  ctx.font = '400 20px "Segoe UI", Arial';
  ctx.fillStyle = '#cbd5f5';
  ctx.fillText(`Customer`, 40, 130);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(customerEmail, 40, 160);

  ctx.fillStyle = '#cbd5f5';
  ctx.fillText('Ticket ID', 40, 220);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(ticketId, 40, 250);

  if (orderNumber) {
    ctx.fillStyle = '#cbd5f5';
    ctx.fillText('Order Number', 40, 310);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(orderNumber, 40, 340);
  }

  ctx.fillStyle = '#cbd5f5';
  ctx.fillText('Status', 40, 400);
  ctx.fillStyle = '#22d3ee';
  ctx.fillText(status.toUpperCase(), 40, 430);

  const qrDataUrl = await QRCode.toDataURL(qrPayload, {
    errorCorrectionLevel: 'H',
    color: { dark: '#0f172a', light: '#ffffff' },
    width: 320,
  });
  const qrImage = await loadImage(qrDataUrl);
  const qrSize = 360;
  const qrX = (WIDTH - qrSize) / 2;
  const qrY = HEIGHT - qrSize - 90;
  drawRoundedContainer(ctx, qrX - 20, qrY - 20, qrSize + 40, qrSize + 40, 24, '#ffffff');
  ctx.drawImage(qrImage, qrX, qrY, qrSize, qrSize);

  const buffer = canvas.toBuffer('image/png');
  const filename = `ticket-${ticketId}.png`;
  const cid = `ticket-${ticketId}@connect-fulfillment`;

  return { buffer, filename, cid };
};

const drawRoundedContainer = (
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fillStyle: string
) => {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
  ctx.restore();
};
