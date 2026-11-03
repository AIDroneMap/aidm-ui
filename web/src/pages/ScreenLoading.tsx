/** A screen on its way: its own words, then grey rows where the content will be. Screen readers hear the words once. */
export function ScreenLoading({ text, lines = 3 }: { text: string; lines?: number }) {
  return (
    <div className="skeleton screen-loading" role="status" aria-busy="true">
      <p className="hint">{text}</p>
      {Array.from({ length: lines }, (_, index) => (
        <span className="skeleton-line" aria-hidden="true" key={index} />
      ))}
    </div>
  );
}
