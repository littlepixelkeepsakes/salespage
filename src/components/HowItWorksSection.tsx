import React from 'react';
import { ArrowRight } from 'lucide-react';

interface HowItWorksSectionProps {
  onCreateKeepsake: () => void;
}

type BeadColor = 'coral' | 'coralDark' | 'teal' | 'tealDark' | 'navy' | 'cream' | 'gold' | 'silver';

const BEAD_FILLS: Record<BeadColor, { fill: string; hole: string }> = {
  coral: { fill: '#FF8D76', hole: '#FAF6EE' },
  coralDark: { fill: '#E05A40', hole: '#FAF6EE' },
  teal: { fill: '#3FA499', hole: '#FAF6EE' },
  tealDark: { fill: '#287A72', hole: '#FAF6EE' },
  navy: { fill: '#14233C', hole: '#FAF6EE' },
  cream: { fill: '#F3E9D7', hole: '#FFFFFF' },
  gold: { fill: '#F4C15D', hole: '#FAF6EE' },
  silver: { fill: '#94A3B8', hole: '#FAF6EE' }
};

interface BeadCell {
  x: number;
  y: number;
  c: BeadColor;
}

/**
 * Renders a crisp Perler-bead pixel grid where each cell is a round fused bead
 * with an authentic hollow centre hole, matching the Little Pixel Keepsakes logo.
 */
function PerlerBeadArt({
  cells,
  gridW = 12,
  gridH = 12,
  label
}: {
  cells: BeadCell[];
  gridW?: number;
  gridH?: number;
  label: string;
}) {
  const step = 8;
  const pad = 4;
  const width = gridW * step + pad * 2;
  const height = gridH * step + pad * 2;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      className="w-16 h-16 sm:w-20 sm:h-20 shrink-0 select-none"
    >
      {/* Subtle dark outline backing behind fused beads */}
      {cells.map((cell, idx) => (
        <circle
          key={`bg-${idx}`}
          cx={pad + cell.x * step + step / 2}
          cy={pad + cell.y * step + step / 2}
          r={4.35}
          fill="#14233C"
          fillOpacity="0.16"
        />
      ))}
      {/* Individual Perler beads with centre pegboard hole */}
      {cells.map((cell, idx) => {
        const cx = pad + cell.x * step + step / 2;
        const cy = pad + cell.y * step + step / 2;
        const palette = BEAD_FILLS[cell.c];
        return (
          <g key={`b-${idx}`}>
            <circle cx={cx} cy={cy} r={3.65} fill={palette.fill} />
            <circle cx={cx} cy={cy} r={1.2} fill={palette.hole} />
          </g>
        );
      })}
    </svg>
  );
}

// Step 1: Keychain (left: silver ring + symmetric coral/teal beaded heart charm) & Fridge Magnet (right: framed beaded magnet tile + U-magnet)
const STEP_1_BEADS: BeadCell[] = [
  // Keychain metal ring (centred over x=2)
  { x: 1, y: 1, c: 'silver' },
  { x: 2, y: 1, c: 'silver' },
  { x: 3, y: 1, c: 'silver' },
  { x: 1, y: 2, c: 'silver' },
  { x: 3, y: 2, c: 'silver' },
  { x: 2, y: 3, c: 'navy' },
  // Symmetric 5-bead-wide Perler heart charm (x=0..4, centre x=2)
  { x: 1, y: 4, c: 'coral' },
  { x: 3, y: 4, c: 'coral' },
  { x: 0, y: 5, c: 'coral' },
  { x: 1, y: 5, c: 'coral' },
  { x: 2, y: 5, c: 'coral' },
  { x: 3, y: 5, c: 'coral' },
  { x: 4, y: 5, c: 'coral' },
  { x: 0, y: 6, c: 'coral' },
  { x: 1, y: 6, c: 'teal' },
  { x: 2, y: 6, c: 'coral' },
  { x: 3, y: 6, c: 'teal' },
  { x: 4, y: 6, c: 'coral' },
  { x: 1, y: 7, c: 'coral' },
  { x: 2, y: 7, c: 'teal' },
  { x: 3, y: 7, c: 'coral' },
  { x: 2, y: 8, c: 'coralDark' },

  // Fridge Magnet (right: framed square beaded magnet tile x=7..11 + U-magnet)
  { x: 7, y: 2, c: 'navy' },
  { x: 8, y: 2, c: 'navy' },
  { x: 9, y: 2, c: 'navy' },
  { x: 10, y: 2, c: 'navy' },
  { x: 11, y: 2, c: 'navy' },
  { x: 7, y: 3, c: 'navy' },
  { x: 8, y: 3, c: 'teal' },
  { x: 9, y: 3, c: 'teal' },
  { x: 10, y: 3, c: 'teal' },
  { x: 11, y: 3, c: 'navy' },
  { x: 7, y: 4, c: 'navy' },
  { x: 8, y: 4, c: 'teal' },
  { x: 9, y: 4, c: 'coral' },
  { x: 10, y: 4, c: 'teal' },
  { x: 11, y: 4, c: 'navy' },
  { x: 7, y: 5, c: 'navy' },
  { x: 8, y: 5, c: 'teal' },
  { x: 9, y: 5, c: 'teal' },
  { x: 10, y: 5, c: 'teal' },
  { x: 11, y: 5, c: 'navy' },
  { x: 7, y: 6, c: 'navy' },
  { x: 8, y: 6, c: 'navy' },
  { x: 9, y: 6, c: 'navy' },
  { x: 10, y: 6, c: 'navy' },
  { x: 11, y: 6, c: 'navy' },
  // U-shaped magnet symbol below the fridge magnet tile (centred at x=9)
  { x: 8, y: 8, c: 'silver' },
  { x: 10, y: 8, c: 'silver' },
  { x: 8, y: 9, c: 'coral' },
  { x: 10, y: 9, c: 'coral' },
  { x: 8, y: 10, c: 'coralDark' },
  { x: 9, y: 10, c: 'coralDark' },
  { x: 10, y: 10, c: 'coralDark' }
];

// Step 2: Symmetric photo frame (x=1..11, centre x=6) with landscape inside + coral upload arrow
const STEP_2_BEADS: BeadCell[] = [
  // Coral upward upload arrow (centred at x=6)
  { x: 6, y: 0, c: 'coralDark' },
  { x: 5, y: 1, c: 'coral' },
  { x: 6, y: 1, c: 'coral' },
  { x: 7, y: 1, c: 'coral' },
  { x: 4, y: 2, c: 'coral' },
  { x: 6, y: 2, c: 'coral' },
  { x: 8, y: 2, c: 'coral' },
  { x: 6, y: 3, c: 'coral' },

  // Navy photo frame top border (x=1..11)
  { x: 1, y: 4, c: 'navy' },
  { x: 2, y: 4, c: 'navy' },
  { x: 3, y: 4, c: 'navy' },
  { x: 4, y: 4, c: 'navy' },
  { x: 5, y: 4, c: 'navy' },
  { x: 6, y: 4, c: 'coral' },
  { x: 7, y: 4, c: 'navy' },
  { x: 8, y: 4, c: 'navy' },
  { x: 9, y: 4, c: 'navy' },
  { x: 10, y: 4, c: 'navy' },
  { x: 11, y: 4, c: 'navy' },

  // Photo interior: golden sun + coral & teal hills
  { x: 1, y: 5, c: 'navy' },
  { x: 2, y: 5, c: 'cream' },
  { x: 3, y: 5, c: 'gold' },
  { x: 4, y: 5, c: 'cream' },
  { x: 5, y: 5, c: 'cream' },
  { x: 6, y: 5, c: 'cream' },
  { x: 7, y: 5, c: 'cream' },
  { x: 8, y: 5, c: 'cream' },
  { x: 9, y: 5, c: 'cream' },
  { x: 10, y: 5, c: 'cream' },
  { x: 11, y: 5, c: 'navy' },

  { x: 1, y: 6, c: 'navy' },
  { x: 2, y: 6, c: 'cream' },
  { x: 3, y: 6, c: 'cream' },
  { x: 4, y: 6, c: 'cream' },
  { x: 5, y: 6, c: 'cream' },
  { x: 6, y: 6, c: 'teal' },
  { x: 7, y: 6, c: 'teal' },
  { x: 8, y: 6, c: 'teal' },
  { x: 9, y: 6, c: 'cream' },
  { x: 10, y: 6, c: 'cream' },
  { x: 11, y: 6, c: 'navy' },

  { x: 1, y: 7, c: 'navy' },
  { x: 2, y: 7, c: 'cream' },
  { x: 3, y: 7, c: 'coral' },
  { x: 4, y: 7, c: 'coral' },
  { x: 5, y: 7, c: 'teal' },
  { x: 6, y: 7, c: 'teal' },
  { x: 7, y: 7, c: 'teal' },
  { x: 8, y: 7, c: 'teal' },
  { x: 9, y: 7, c: 'teal' },
  { x: 10, y: 7, c: 'cream' },
  { x: 11, y: 7, c: 'navy' },

  { x: 1, y: 8, c: 'navy' },
  { x: 2, y: 8, c: 'coral' },
  { x: 3, y: 8, c: 'coral' },
  { x: 4, y: 8, c: 'coral' },
  { x: 5, y: 8, c: 'tealDark' },
  { x: 6, y: 8, c: 'teal' },
  { x: 7, y: 8, c: 'teal' },
  { x: 8, y: 8, c: 'tealDark' },
  { x: 9, y: 8, c: 'tealDark' },
  { x: 10, y: 8, c: 'tealDark' },
  { x: 11, y: 8, c: 'navy' },

  // Bottom polaroid chin
  { x: 1, y: 9, c: 'navy' },
  { x: 2, y: 9, c: 'cream' },
  { x: 3, y: 9, c: 'cream' },
  { x: 4, y: 9, c: 'cream' },
  { x: 5, y: 9, c: 'cream' },
  { x: 6, y: 9, c: 'cream' },
  { x: 7, y: 9, c: 'cream' },
  { x: 8, y: 9, c: 'cream' },
  { x: 9, y: 9, c: 'cream' },
  { x: 10, y: 9, c: 'cream' },
  { x: 11, y: 9, c: 'navy' },

  { x: 1, y: 10, c: 'navy' },
  { x: 2, y: 10, c: 'navy' },
  { x: 3, y: 10, c: 'navy' },
  { x: 4, y: 10, c: 'navy' },
  { x: 5, y: 10, c: 'navy' },
  { x: 6, y: 10, c: 'navy' },
  { x: 7, y: 10, c: 'navy' },
  { x: 8, y: 10, c: 'navy' },
  { x: 9, y: 10, c: 'navy' },
  { x: 10, y: 10, c: 'navy' },
  { x: 11, y: 10, c: 'navy' }
];

// Step 3: Wallet (navy with coral clasp) + Teal payment card tucked inside
const STEP_3_BEADS: BeadCell[] = [
  // Teal payment card peeking out top-right
  { x: 4, y: 1, c: 'teal' },
  { x: 5, y: 1, c: 'teal' },
  { x: 6, y: 1, c: 'teal' },
  { x: 7, y: 1, c: 'teal' },
  { x: 8, y: 1, c: 'teal' },
  { x: 9, y: 1, c: 'teal' },
  { x: 4, y: 2, c: 'teal' },
  { x: 5, y: 2, c: 'gold' }, // EMV gold chip
  { x: 6, y: 2, c: 'teal' },
  { x: 7, y: 2, c: 'teal' },
  { x: 8, y: 2, c: 'coral' }, // card brand accent
  { x: 9, y: 2, c: 'teal' },
  { x: 4, y: 3, c: 'tealDark' },
  { x: 5, y: 3, c: 'tealDark' },
  { x: 6, y: 3, c: 'tealDark' },
  { x: 7, y: 3, c: 'tealDark' },
  { x: 8, y: 3, c: 'tealDark' },
  { x: 9, y: 3, c: 'tealDark' },

  // Navy leather wallet body
  { x: 1, y: 4, c: 'navy' },
  { x: 2, y: 4, c: 'navy' },
  { x: 3, y: 4, c: 'navy' },
  { x: 4, y: 4, c: 'navy' },
  { x: 5, y: 4, c: 'navy' },
  { x: 6, y: 4, c: 'navy' },
  { x: 7, y: 4, c: 'navy' },
  { x: 8, y: 4, c: 'navy' },
  { x: 9, y: 4, c: 'navy' },
  { x: 10, y: 4, c: 'navy' },

  { x: 1, y: 5, c: 'navy' },
  { x: 2, y: 5, c: 'navy' },
  { x: 3, y: 5, c: 'teal' },
  { x: 4, y: 5, c: 'navy' },
  { x: 5, y: 5, c: 'teal' },
  { x: 6, y: 5, c: 'navy' },
  { x: 7, y: 5, c: 'navy' },
  { x: 8, y: 5, c: 'navy' },
  { x: 9, y: 5, c: 'navy' },
  { x: 10, y: 5, c: 'navy' },

  // Wallet middle with coral latch flap on right
  { x: 1, y: 6, c: 'navy' },
  { x: 2, y: 6, c: 'navy' },
  { x: 3, y: 6, c: 'navy' },
  { x: 4, y: 6, c: 'navy' },
  { x: 5, y: 6, c: 'navy' },
  { x: 6, y: 6, c: 'navy' },
  { x: 7, y: 6, c: 'coral' },
  { x: 8, y: 6, c: 'coral' },
  { x: 9, y: 6, c: 'coral' },
  { x: 10, y: 6, c: 'coral' },
  { x: 11, y: 6, c: 'coralDark' },

  { x: 1, y: 7, c: 'navy' },
  { x: 2, y: 7, c: 'navy' },
  { x: 3, y: 7, c: 'navy' },
  { x: 4, y: 7, c: 'navy' },
  { x: 5, y: 7, c: 'navy' },
  { x: 6, y: 7, c: 'navy' },
  { x: 7, y: 7, c: 'coral' },
  { x: 8, y: 7, c: 'gold' }, // clasp button
  { x: 9, y: 7, c: 'coral' },
  { x: 10, y: 7, c: 'coral' },
  { x: 11, y: 7, c: 'coralDark' },

  { x: 1, y: 8, c: 'navy' },
  { x: 2, y: 8, c: 'navy' },
  { x: 3, y: 8, c: 'navy' },
  { x: 4, y: 8, c: 'navy' },
  { x: 5, y: 8, c: 'navy' },
  { x: 6, y: 8, c: 'navy' },
  { x: 7, y: 8, c: 'navy' },
  { x: 8, y: 8, c: 'navy' },
  { x: 9, y: 8, c: 'navy' },
  { x: 10, y: 8, c: 'navy' },

  { x: 1, y: 9, c: 'navy' },
  { x: 2, y: 9, c: 'navy' },
  { x: 3, y: 9, c: 'navy' },
  { x: 4, y: 9, c: 'navy' },
  { x: 5, y: 9, c: 'navy' },
  { x: 6, y: 9, c: 'navy' },
  { x: 7, y: 9, c: 'navy' },
  { x: 8, y: 9, c: 'navy' },
  { x: 9, y: 9, c: 'navy' },
  { x: 10, y: 9, c: 'navy' }
];

// Step 4: Gift box with teal ribbon bow (on truck bed) + cute delivery truck
const STEP_4_BEADS: BeadCell[] = [
  // Gift ribbon bow peeking above truck cargo
  { x: 2, y: 1, c: 'teal' },
  { x: 4, y: 1, c: 'teal' },
  { x: 2, y: 2, c: 'teal' },
  { x: 3, y: 2, c: 'tealDark' },
  { x: 4, y: 2, c: 'teal' },

  // Coral gift box loaded as the delivery truck cargo box
  { x: 1, y: 3, c: 'coral' },
  { x: 2, y: 3, c: 'coral' },
  { x: 3, y: 3, c: 'teal' },
  { x: 4, y: 3, c: 'coral' },
  { x: 5, y: 3, c: 'coral' },
  { x: 6, y: 3, c: 'coral' },

  { x: 1, y: 4, c: 'coral' },
  { x: 2, y: 4, c: 'coral' },
  { x: 3, y: 4, c: 'teal' },
  { x: 4, y: 4, c: 'coral' },
  { x: 5, y: 4, c: 'coral' },
  { x: 6, y: 4, c: 'coral' },

  // Horizontal ribbon + truck cab roof
  { x: 1, y: 5, c: 'teal' },
  { x: 2, y: 5, c: 'teal' },
  { x: 3, y: 5, c: 'tealDark' },
  { x: 4, y: 5, c: 'teal' },
  { x: 5, y: 5, c: 'teal' },
  { x: 6, y: 5, c: 'teal' },
  { x: 7, y: 5, c: 'navy' },
  { x: 8, y: 5, c: 'navy' },
  { x: 9, y: 5, c: 'navy' },

  // Gift lower body + truck windshield window
  { x: 1, y: 6, c: 'coral' },
  { x: 2, y: 6, c: 'coral' },
  { x: 3, y: 6, c: 'teal' },
  { x: 4, y: 6, c: 'coral' },
  { x: 5, y: 6, c: 'coral' },
  { x: 6, y: 6, c: 'coral' },
  { x: 7, y: 6, c: 'navy' },
  { x: 8, y: 6, c: 'cream' }, // cab window
  { x: 9, y: 6, c: 'cream' },
  { x: 10, y: 6, c: 'navy' },

  // Truck chassis & cab front
  { x: 1, y: 7, c: 'navy' },
  { x: 2, y: 7, c: 'navy' },
  { x: 3, y: 7, c: 'navy' },
  { x: 4, y: 7, c: 'navy' },
  { x: 5, y: 7, c: 'navy' },
  { x: 6, y: 7, c: 'navy' },
  { x: 7, y: 7, c: 'navy' },
  { x: 8, y: 7, c: 'navy' },
  { x: 9, y: 7, c: 'navy' },
  { x: 10, y: 7, c: 'navy' },
  { x: 11, y: 7, c: 'gold' }, // headlight

  { x: 1, y: 8, c: 'navy' },
  { x: 2, y: 8, c: 'navy' },
  { x: 3, y: 8, c: 'navy' },
  { x: 4, y: 8, c: 'navy' },
  { x: 5, y: 8, c: 'navy' },
  { x: 6, y: 8, c: 'navy' },
  { x: 7, y: 8, c: 'navy' },
  { x: 8, y: 8, c: 'navy' },
  { x: 9, y: 8, c: 'navy' },
  { x: 10, y: 8, c: 'navy' },
  { x: 11, y: 8, c: 'navy' },

  // Wheels (2 crisp beaded wheels)
  { x: 2, y: 9, c: 'navy' },
  { x: 3, y: 9, c: 'silver' },
  { x: 8, y: 9, c: 'navy' },
  { x: 9, y: 9, c: 'silver' },
  { x: 2, y: 10, c: 'silver' },
  { x: 3, y: 10, c: 'navy' },
  { x: 8, y: 10, c: 'silver' },
  { x: 9, y: 10, c: 'navy' }
];

interface HowItWorksStep {
  stepNumber: string;
  title: string;
  description: string;
  accentClass: string;
  iconBgClass: string;
  beads: BeadCell[];
  gridW?: number;
  iconLabel: string;
}

const STEPS: HowItWorksStep[] = [
  {
    stepNumber: 'Step 1',
    title: 'Pick Your Keepsake',
    description: 'Choose a personalised keychain, fridge magnet or 2-piece bundle.',
    accentClass: 'text-[#C9482E]',
    iconBgClass: 'bg-[#FF8D76]/12',
    beads: STEP_1_BEADS,
    iconLabel: 'Perler bead keychain and fridge magnet illustration'
  },
  {
    stepNumber: 'Step 2',
    title: 'Upload Your Photo',
    description: 'Upload your favourite clear, high-resolution photo.',
    accentClass: 'text-[#287A72]',
    iconBgClass: 'bg-[#3FA499]/12',
    beads: STEP_2_BEADS,
    gridW: 13,
    iconLabel: 'Perler bead photo frame with upload arrow illustration'
  },
  {
    stepNumber: 'Step 3',
    title: 'Make Payment',
    description:
      'Pay using Touch ’n Go eWallet, Public Bank QR Pay, or credit/debit card via Stripe.',
    accentClass: 'text-[#C9482E]',
    iconBgClass: 'bg-[#FF8D76]/12',
    beads: STEP_3_BEADS,
    iconLabel: 'Perler bead wallet and payment card illustration'
  },
  {
    stepNumber: 'Step 4',
    title: 'Receive Your Keepsake',
    description:
      'Your personalised handmade gift will be delivered within 14 days after payment confirmation and receipt of a usable photo.',
    accentClass: 'text-[#287A72]',
    iconBgClass: 'bg-[#3FA499]/12',
    beads: STEP_4_BEADS,
    iconLabel: 'Perler bead gift box and delivery truck illustration'
  }
];

export default function HowItWorksSection({ onCreateKeepsake }: HowItWorksSectionProps) {
  return (
    <section
      id="how-it-works"
      aria-labelledby="how-it-works-heading"
      className="py-14 sm:py-16 px-4 sm:px-8 border-y border-[#14233C]/10 bg-white/55"
    >
      <div className="max-w-6xl mx-auto">
        <div className="text-center max-w-2xl mx-auto space-y-2 mb-10 sm:mb-12">
          <p className="text-xs font-bold tracking-wide text-[#287A72]">
            How It Works
          </p>
          <h2
            id="how-it-works-heading"
            className="text-2xl sm:text-4xl font-extrabold tracking-tight text-[#14233C] [text-wrap:balance]"
          >
            Your Memories, Made in 4 Simple Steps
          </h2>
        </div>

        {/* Compact 2x2 grid on mobile, 4-column horizontal row with connecting arrows on desktop */}
        <ol className="grid grid-cols-2 lg:grid-cols-4 gap-3.5 sm:gap-5 lg:gap-7">
          {STEPS.map((step, index) => {
            const isLast = index === STEPS.length - 1;
            return (
              <li key={step.stepNumber} className="relative flex">
                <article className="w-full bg-white rounded-2xl border border-[#14233C]/12 p-4 sm:p-5 lg:p-6 flex flex-col items-center text-center transition-transform duration-200 hover:-translate-y-0.5">
                  <div
                    className={`w-20 h-20 sm:w-24 sm:h-24 rounded-2xl ${step.iconBgClass} flex items-center justify-center mb-3.5 sm:mb-4`}
                  >
                    <PerlerBeadArt
                      cells={step.beads}
                      gridW={step.gridW ?? 12}
                      label={step.iconLabel}
                    />
                  </div>

                  <p className={`text-xs font-bold tabular-nums ${step.accentClass}`}>
                    {step.stepNumber}
                  </p>

                  <h3 className="mt-1 text-sm sm:text-base font-extrabold text-[#14233C] leading-snug [text-wrap:balance]">
                    {step.title}
                  </h3>

                  <p className="mt-2 text-xs sm:text-[13px] text-[#14233C]/75 leading-relaxed">
                    {step.description}
                  </p>
                </article>

                {/* Subtle desktop connector arrow centred in the 28px gap between adjacent cards */}
                {!isLast && (
                  <div
                    aria-hidden="true"
                    className="hidden lg:flex items-center justify-center absolute -right-7 top-1/2 -translate-y-1/2 z-10 w-7 text-[#3FA499]/75 pointer-events-none"
                  >
                    <svg
                      viewBox="0 0 20 20"
                      fill="none"
                      className="w-5 h-5 shrink-0"
                    >
                      <path
                        d="M3 10H16M16 10L11.5 5.5M16 10L11.5 14.5"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                )}
              </li>
            );
          })}
        </ol>

        <div className="mt-9 sm:mt-11 flex justify-center">
          <button
            type="button"
            onClick={onCreateKeepsake}
            className="w-full sm:w-auto bg-[#FF8D76] text-[#14233C] font-bold px-8 py-4 rounded-2xl shadow-lg shadow-[#FF8D76]/30 hover:bg-[#ff7b60] active:scale-95 transition-all inline-flex items-center justify-center gap-3 text-base whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14233C]"
          >
            <span>Create My Keepsake</span>
            <ArrowRight className="w-5 h-5 shrink-0" />
          </button>
        </div>
      </div>
    </section>
  );
}
