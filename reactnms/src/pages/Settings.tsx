export default function Settings() {
  return (
    <div className="settings-page">
      <div className="page-header">
        <h1>Settings</h1>
        <p>Configure your Network Management System</p>
      </div>
      <div className="card">
        <h3>Polling & Discovery</h3>
        <div className="setting-row">
          <label>SNMP Community String</label>
          <input type="text" defaultValue="public" />
        </div>
        <div className="setting-row">
          <label>Polling Interval</label>
          <select defaultValue="60">
            <option value="30">30 seconds</option>
            <option value="60">1 minute</option>
            <option value="300">5 minutes</option>
          </select>
        </div>
        <div className="setting-row">
          <label>Auto-Discovery</label>
          <input type="checkbox" defaultChecked />
        </div>
      </div>
      <div className="card">
        <h3>Notifications</h3>
        <div className="setting-row">
          <label>Email Alerts</label>
          <input type="checkbox" defaultChecked />
        </div>
        <div className="setting-row">
          <label>Critical Alert Threshold</label>
          <input type="number" defaultValue="90" /> %
        </div>
      </div>
      <button className="btn-primary">Save Settings</button>
    </div>
  );
}
