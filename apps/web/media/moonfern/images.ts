/* Simple plant-care screen mockups served at /api/attachments/<id> for the designer's 3-way choice in tasks.gif. */
export const ATTACHMENT_SVGS: Record<string, string> = {
  'choice-botanical': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 210">
    <rect width="320" height="210" rx="12" fill="#F2F7F4"/>
    <rect x="24" y="18" width="272" height="174" rx="14" fill="#FFFFFF" stroke="#CFDED4" stroke-width="2"/>
    <rect x="40" y="34" width="96" height="142" rx="10" fill="#E1F0E6"/>
    <path d="M88 152 C88 112 62 96 60 66 C84 70 100 92 92 126 C98 98 116 80 122 60 C126 92 110 120 88 152 Z" fill="#2E7D52"/>
    <line x1="88" y1="152" x2="88" y2="164" stroke="#235E3E" stroke-width="3" stroke-linecap="round"/>
    <text x="152" y="58" font-family="system-ui, sans-serif" font-size="15" font-weight="700" fill="#132A1E">Monstera deliciosa</text>
    <text x="152" y="78" font-family="system-ui, sans-serif" font-size="12" fill="#526B5D">Bright indirect light</text>
    <rect x="152" y="96" width="124" height="28" rx="7" fill="#EAF5EE"/>
    <text x="164" y="114" font-family="system-ui, sans-serif" font-size="12" font-weight="600" fill="#216E43">Water in 2 days</text>
    <rect x="152" y="134" width="124" height="32" rx="8" fill="#1F7A4C"/>
    <text x="184" y="154" font-family="system-ui, sans-serif" font-size="12" font-weight="700" fill="#FFFFFF">Mark watered</text>
  </svg>`,
  'choice-dial': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 210">
    <rect width="320" height="210" rx="12" fill="#F4F6F9"/>
    <rect x="24" y="18" width="272" height="174" rx="14" fill="#FFFFFF" stroke="#D3DCE6" stroke-width="2"/>
    <circle cx="104" cy="105" r="52" fill="none" stroke="#E4ECF2" stroke-width="12"/>
    <path d="M 60 133 A 52 52 0 1 1 148 133" fill="none" stroke="#0095B6" stroke-width="12" stroke-linecap="round"/>
    <text x="104" y="102" text-anchor="middle" font-family="system-ui, sans-serif" font-size="20" font-weight="700" fill="#0F1B27">68%</text>
    <text x="104" y="120" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#58697A">Soil moisture</text>
    <text x="178" y="64" font-family="system-ui, sans-serif" font-size="15" font-weight="700" fill="#0F1B27">Fiddle-leaf fig</text>
    <text x="178" y="84" font-family="system-ui, sans-serif" font-size="12" fill="#58697A">South window, 640 lx</text>
    <rect x="178" y="102" width="98" height="24" rx="6" fill="#FFF4DF"/>
    <text x="190" y="118" font-family="system-ui, sans-serif" font-size="11" font-weight="600" fill="#9A5A00">Mist leaves</text>
    <rect x="178" y="136" width="98" height="28" rx="7" fill="#00768A"/>
    <text x="198" y="154" font-family="system-ui, sans-serif" font-size="12" font-weight="700" fill="#FFFFFF">Log check</text>
  </svg>`,
  'choice-list': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 210">
    <rect width="320" height="210" rx="12" fill="#F5F7F8"/>
    <rect x="24" y="18" width="272" height="174" rx="14" fill="#FFFFFF" stroke="#D2DBE3" stroke-width="2"/>
    <g transform="translate(38, 34)">
      <rect width="244" height="40" rx="8" fill="#EEF6F1"/>
      <circle cx="22" cy="20" r="10" fill="#2E7D52"/>
      <text x="42" y="18" font-family="system-ui, sans-serif" font-size="12" font-weight="700" fill="#132A1E">Monstera deliciosa</text>
      <text x="42" y="32" font-family="system-ui, sans-serif" font-size="10" fill="#526B5D">Living room · Today</text>
      <rect x="184" y="10" width="48" height="20" rx="5" fill="#1F7A4C"/>
      <text x="194" y="24" font-family="system-ui, sans-serif" font-size="10" font-weight="700" fill="#FFFFFF">Water</text>
    </g>
    <g transform="translate(38, 84)">
      <rect width="244" height="40" rx="8" fill="#F4F7FA"/>
      <circle cx="22" cy="20" r="10" fill="#0095B6"/>
      <text x="42" y="18" font-family="system-ui, sans-serif" font-size="12" font-weight="700" fill="#132A1E">Calathea orbifolia</text>
      <text x="42" y="32" font-family="system-ui, sans-serif" font-size="10" fill="#526B5D">Bedroom · In 2 days</text>
      <text x="192" y="24" font-family="system-ui, sans-serif" font-size="11" font-weight="600" fill="#4C5A68">2 d</text>
    </g>
    <g transform="translate(38, 134)">
      <rect width="244" height="40" rx="8" fill="#F4F7FA"/>
      <circle cx="22" cy="20" r="10" fill="#5D8C3E"/>
      <text x="42" y="18" font-family="system-ui, sans-serif" font-size="12" font-weight="700" fill="#132A1E">Snake plant</text>
      <text x="42" y="32" font-family="system-ui, sans-serif" font-size="10" fill="#526B5D">Study · In 9 days</text>
      <text x="192" y="24" font-family="system-ui, sans-serif" font-size="11" font-weight="600" fill="#4C5A68">9 d</text>
    </g>
  </svg>`,
};
