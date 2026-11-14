export default function Loading() {
  return (
    <main className="tezkar-route-loader" role="status" aria-live="polite" aria-label="جارٍ تحميل الصفحة">
      <div className="tezkar-route-loader-card">
        <img className="tezkar-route-loader-logo" src="https://raw.githubusercontent.com/alomdamohamed652-afk/Tezkar/main/tezkar%20logo.png" alt="شعار تذكار" />
        <div className="tezkar-route-loader-title">تذكار</div>
        <div className="tezkar-route-loader-spinner" aria-hidden="true" />
        <div className="tezkar-route-loader-dhikr">اذكر الله</div>
      </div>
    </main>
  );
}
