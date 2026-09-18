let projects = [];

const projectGrid = document.getElementById("projectGrid");

async function loadProjects() {

    const response = await fetch("data/projects.json");

    projects = await response.json();

    populateDepartmentFilter();

    displayProjects(projects);

    updateStats();

    // Wire up search and filter
    document.getElementById("searchBox").addEventListener("input", applyFilters);
    document.getElementById("departmentFilter").addEventListener("change", applyFilters);

}

function populateDepartmentFilter() {

    const select = document.getElementById("departmentFilter");
    const departments = [...new Set(projects.map(p => p.department).filter(Boolean))].sort();

    departments.forEach(dept => {

        const option = document.createElement("option");
        option.value = dept;
        option.textContent = dept;
        select.appendChild(option);

    });

}

function applyFilters() {

    const query = document.getElementById("searchBox").value.toLowerCase().trim();
    const dept  = document.getElementById("departmentFilter").value;

    const filtered = projects.filter(project => {

        const matchesDept = !dept || project.department === dept;

        const matchesSearch = !query ||
            project.title.toLowerCase().includes(query) ||
            project.student.toLowerCase().includes(query) ||
            project.summary.toLowerCase().includes(query) ||
            (project.tech || []).some(t => t.toLowerCase().includes(query));

        return matchesDept && matchesSearch;

    });

    displayProjects(filtered);

}

function displayProjects(data) {

    projectGrid.innerHTML = "";

    data.forEach(project => {

        projectGrid.innerHTML += `

        <div class="card">

            <img src="${project.image}" alt="${project.title}">

            <div class="card-body">

                <h2>${project.title}</h2>

                <p><strong>${project.student}</strong></p>

                <p>${project.department}</p>

                <p>${project.summary}</p>

                <div class="tags">

                    ${(project.tech || []).map(t => `<span>${t}</span>`).join("")}

                </div>

                <div class="buttons">

                    <a href="${project.github}" target="_blank">GitHub</a>

                    ${project.demo ? `<a href="${project.demo}" target="_blank">Live Demo</a>` : ""}

                    ${project.zipUrl ? `<a href="${project.zipUrl}" class="btn-download" download>⬇ Download .zip</a>` : ""}

                </div>

            </div>

        </div>

        `;

    });

}

function updateStats(){

    document.getElementById("projectCount").textContent = projects.length;

    document.getElementById("studentCount").textContent = projects.length;

    const departments = [...new Set(projects.map(p=>p.department))];

    document.getElementById("departmentCount").textContent = departments.length;

}

loadProjects();