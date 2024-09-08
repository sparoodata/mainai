window.onload = async () => {
    const response = await fetch('/dashboard');
    const data = await response.json();

    // Display properties
    const propertiesDiv = document.getElementById('properties');
    propertiesDiv.innerHTML = '<h2>Properties</h2>';
    data.properties.forEach(property => {
        propertiesDiv.innerHTML += `
            <div>
                <h3>${property.name}</h3>
                <p>Units: ${property.units}</p>
                <p>Total Amount Received: ${property.totalAmount}</p>
            </div>
        `;
    });

    // Display tenants
    const tenantsDiv = document.getElementById('tenants');
    tenantsDiv.innerHTML = '<h2>Tenants</h2>';
    data.tenants.forEach(tenant => {
        tenantsDiv.innerHTML += `
            <div>
                <p>Name: ${tenant.name}</p>
                <p>Phone Number: ${tenant.phoneNumber}</p>
                <p>Status: ${tenant.status}</p>
                <button onclick="markAsPaid('${tenant._id}')">Mark as Paid</button>
            </div>
        `;
    });
};

async function markAsPaid(tenantId) {
    const response = await fetch(`/dashboard/tenant/${tenantId}/markAsPaid`, {
        method: 'POST'
    });
    
    if (response.ok) {
        alert('Tenant marked as paid!');
        window.location.reload(); // Refresh the dashboard
    } else {
        alert('Error updating tenant status.');
    }
}
