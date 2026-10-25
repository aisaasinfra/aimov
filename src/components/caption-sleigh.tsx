/* 封面流标题牌：左侧两只驯鹿、中间奶油铭牌（只有世界名）、右侧圣诞老人雪橇。装饰用 SVG，名字是文本。 */

function Reindeer({ transform, berryNose = false }: { transform?: string; berryNose?: boolean }) {
  return (
    <g transform={transform}>
      <g fill="none" stroke="#5c3a22" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
        <path d="M33 38C26 26 18 18 10 11" />
        <path d="M24 24c-5-4-5-9-2-13" />
        <path d="M29 20c3-6 8-8 11-6" />
        <path d="M41 36c9-13 20-18 31-19" />
        <path d="M50 25c5-7 12-9 16-6" />
        <path d="M46 29c-3-7 0-12 5-13" />
      </g>
      <path d="M104 54c8-3 14 2 8 8-4 3-10 1-12-3-1-2 0-4 0-5z" fill="#6a4126" />
      <path d="M84 74c1 9 2 16 1 22h-5c0-6 0-14 1-22 1-1 2-1 3 0z" fill="#5c3a22" />
      <path d="M94 72c1 9 2 16 1 22h-5c0-6 0-15 1-22 1-1 2-1 3 0z" fill="#4a301c" />
      <ellipse cx="72" cy="64" rx="32" ry="15.5" fill="#8d5a32" />
      <ellipse cx="66" cy="70" rx="16" ry="6.5" fill="#c4a06a" />
      <path d="M50 76c1 9 1 16 0 20h-5c0-5 0-13 1-20 1-1 3-1 4 0z" fill="#5c3a22" />
      <path d="M60 76c1 9 1 16 0 20h-5c0-5 0-14 1-20 1-1 3-1 4 0z" fill="#4a301c" />
      <path d="M46 56c-2 8 0 14 6 16 3-8 6-14 3-20-3 1-6 2-9 4z" fill="#7a4c2c" />
      <ellipse cx="33" cy="50" rx="15" ry="10.5" fill="#8d5a32" />
      <path d="M40 40c4-9 12-9 13-2-4 1-8 4-10 8-1-2-2-4-3-6z" fill="#6a4126" />
      <ellipse cx="18" cy="54" rx="9" ry="5.6" fill="#a56b3c" />
      <circle cx="10" cy="55" r="2.7" fill={berryNose ? '#8b2d32' : '#5c3a22'} />
      <circle cx="31" cy="47" r="1.45" fill="#1c140f" />
      <circle cx="31.5" cy="46.5" r="0.45" fill="#fff6ea" />
      <path d="M44 60c14-4 32-2 46 7" fill="none" stroke="#8b2d32" strokeWidth="3" strokeLinecap="round" />
      <circle cx="66" cy="61.5" r="2.9" fill="#e6c98a" stroke="#8b2d32" strokeWidth="0.75" />
      <path d="M66 64.2v2.4" stroke="#8b2d32" strokeWidth="0.7" strokeLinecap="round" />
    </g>
  )
}

function ReindeerTeam() {
  return (
    <svg className="merry-caption-reindeer" viewBox="0 0 172 100" aria-hidden="true">
      <Reindeer transform="translate(62 5) scale(0.86)" />
      <Reindeer berryNose />
    </svg>
  )
}

function SleighMark() {
  return (
    <svg className="merry-caption-santa" viewBox="0 0 158 100" aria-hidden="true">
      <path
        d="M16 88c28 10 90 10 122-2"
        fill="none"
        stroke="#e0c27a"
        strokeWidth="3.3"
        strokeLinecap="round"
      />
      <path d="M16 88C8 86 5 78 12 74" fill="none" stroke="#e0c27a" strokeWidth="3.3" strokeLinecap="round" />
      <path d="M138 86c8-1 11-7 6-12" fill="none" stroke="#e0c27a" strokeWidth="3" strokeLinecap="round" />
      <path
        fill="#8b2d32"
        d="M30 72c5 12 22 16 46 16h34c16 0 30-6 32-15 1-7-7-13-16-11-9 4-24 6-42 5-16-1-38-6-50-11-5 4-7 10-4 16z"
      />
      <path d="M34 64c22 8 52 9 86 1" fill="none" stroke="#e6c98a" strokeWidth="2" strokeLinecap="round" />
      <path d="M36 67.5c20 6 46 7 78 1.5" fill="none" stroke="#fff6ea" strokeWidth="2.2" strokeLinecap="round" />
      <path fill="#6e2228" d="M112 56c16 1 26 10 19 19-8 2-15-2-17-8 2-5-1-10-2-11z" />
      <path d="M118 60c9 2 13 8 8 12" fill="none" stroke="#e6c98a" strokeWidth="1.6" strokeLinecap="round" />
      <path fill="#203d32" d="M26 68c-8-6-6-14 0-14 2 4 6 8 8 11-4 1-6 2-8 3z" />
      <path fill="#2a5a40" d="M31 65c8-6 12-6 14-2-5 1-10 3-12 8-1-2-2-4-2-6z" />
      <circle cx="32.5" cy="66" r="2.15" fill="#8b2d32" />
      <g transform="translate(124 36)">
        <path fill="#203d32" d="M6 12C1 7 0 3 3 2c2 3 3 6 3 10z" />
        <path fill="#2a5a40" d="M8 12c5-5 9-5 10-2-4 1-7 3-8 7-1-1-2-3-2-5z" />
        <path fill="#1a332b" d="M4 13c-1 4 2 7 5 6 0-3-1-5-2-7-1 0-2 0-3 1z" />
        <circle cx="7" cy="11" r="1.7" fill="#8b2d32" />
        <circle cx="10.2" cy="9.2" r="1.3" fill="#8b2d32" />
        <circle cx="5" cy="9.5" r="1.15" fill="#8b2d32" />
      </g>
      <g transform="translate(38 2)">
        <path fill="#8b2d32" d="M20 26C20 12 32 5 46 8c6 2 10 8 6 14L22 28z" />
        <ellipse cx="22" cy="27" rx="12.5" ry="4" fill="#fff6ea" />
        <circle cx="54" cy="9" r="4" fill="#fff6ea" />
        <circle cx="34" cy="32" r="10.5" fill="#f3c7a0" />
        <circle cx="29.6" cy="31" r="1.1" fill="#203d32" />
        <circle cx="38.4" cy="31" r="1.1" fill="#203d32" />
        <circle cx="26.2" cy="35" r="1.6" fill="#e7a08a" />
        <circle cx="41.8" cy="35" r="1.6" fill="#e7a08a" />
        <path d="M30 36.2q4 3 8 0" fill="none" stroke="#8b2d32" strokeWidth="1.05" strokeLinecap="round" />
        <path fill="#fff6ea" d="M22 36c-1 15 5 23 12 23s13-8 12-23c-4 7-8 10-12 10s-8-3-12-10z" />
        <path fill="#fff6ea" d="M25 37c4 5 14 5 18 0-5 3-13 3-18 0z" />
        <path fill="#8b2d32" d="M12 58c0-10 10-13 22-13s22 3 22 13l2 20H10z" />
        <path d="M16 52h36" stroke="#fff6ea" strokeWidth="3.2" strokeLinecap="round" />
        <rect x="12" y="64" width="42" height="4.6" rx="1" fill="#203d32" />
        <rect x="29" y="62.7" width="8" height="7.2" rx="1.2" fill="#e6c98a" />
        <ellipse cx="9" cy="66" rx="6.5" ry="4.6" fill="#8b2d32" />
        <rect x="0" y="56" width="12" height="10.5" rx="1.5" fill="#2a5a40" />
        <path d="M6 56v10.5M0 61.2h12" stroke="#e6c98a" strokeWidth="1.45" strokeLinecap="round" />
        <ellipse cx="58" cy="70" rx="5.5" ry="4" fill="#8b2d32" />
        <ellipse cx="59.2" cy="69.2" rx="2.8" ry="2" fill="#f3c7a0" />
      </g>
    </svg>
  )
}

export function CaptionNameplate({ name }: { name: string }) {
  return (
    <div className="merry-caption-sleigh">
      <ReindeerTeam />
      <div className="merry-caption-plate">
        <div className="merry-coverflow-caption-inner">
          <p className="merry-coverflow-title">{name}</p>
        </div>
      </div>
      <SleighMark />
    </div>
  )
}
