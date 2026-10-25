/* 透明插画只作装饰，铭牌上的世界名保留为可翻译、可访问的文本。 */
export function CaptionNameplate({ name }: { name: string }) {
  return (
    <div className="merry-caption-sleigh">
      <img className="merry-caption-ornament" src="/caption-sleigh.webp" width={2172} height={724} alt="" aria-hidden="true" />
      <div className="merry-caption-plate">
        <p className="merry-coverflow-title" title={name}>{name}</p>
      </div>
    </div>
  )
}
