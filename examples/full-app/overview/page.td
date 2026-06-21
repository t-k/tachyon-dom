<script>
import { copy } from "../app";

export default () => ({
  copy: copy(),
});
</script>
<section class="page-grid overview-grid" data-testid="overview-page">
  <article class="panel hero-panel">
    <p class="eyebrow">{copy.summary}</p>
    <h2>{copy.overviewHeadline}</h2>
    <p>{copy.overviewDescription}</p>
    <div class="stat-grid">
      <span><b>{count}</b> {copy.signalCount}</span>
      <span><b>{rowCount}</b> {copy.keyedRows}</span>
      <span><b>{role}</b> {copy.roleMetric}</span>
    </div>
  </article>
  <article class="panel">
    <h2>{copy.activity}</h2>
    <ol class="activity-list">
      <li>{copy.activityRouteState}</li>
      <li>{copy.activityCounter}</li>
      <li>{copy.activityRows}</li>
    </ol>
  </article>
</section>
