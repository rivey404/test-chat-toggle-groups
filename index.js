import { extension_settings, getContext } from "../../../extensions.js";
import { oai_settings, setupChatCompletionPromptManager } from "../../../openai.js";
import { POPUP_TYPE, callGenericPopup } from "../../../popup.js";
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import {
    eventSource,
    event_types,
    saveSettingsDebounced,
} from "../../../../script.js";

const extensionName = "chat-toggle-groups";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
let extensionSettings = extension_settings[extensionName];
const defaultSettings = {
    version: "1.0.0",
    presets: {},
    disableAnimation: true,
};

// DOM element cache to avoid repeated queries
const domCache = {
    toggleGroups: null,
    // More elements will be added as needed
};

// Templates cache
const templateCache = {
    drawerTemplate: '',
    toggleItemTemplate: '',
};

// Store targets for faster access
let availableTargets = [];

const escapeString = (str) => str.replace(/[&<>"']/g, match => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
})[match]);

// Debounce function to avoid excessive operations
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Debounced version of saveSettings
const debouncedSaveSettings = debounce(() => {
    extension_settings[extensionName] = extensionSettings;
    saveSettingsDebounced();
}, 500);

jQuery(async () => {
    await loadSettings();
    const toggleMenu = await $.get(`${extensionFolderPath}/toggle-menu.html`);
    $('.range-block.m-b-1').before(toggleMenu);

    // Cache DOM elements after they're added to the DOM
    domCache.toggleGroups = document.querySelector('.toggle-groups');
    domCache.addToggleGroup = document.querySelector('.add-toggle-group');
    domCache.disableAnimationCheckbox = document.getElementById('disable-animation-checkbox');

    // Pre-fetch available targets
    updateAvailableTargets();

    // Load groups for the current preset
    loadGroupsForCurrentPreset();
    
    // Only attach event listeners once using delegation
    setupEventDelegation();

    // Set initial checkbox state
    domCache.disableAnimationCheckbox.checked = extensionSettings.disableAnimation;

    // Event listeners for global events
    eventSource.on(event_types.OAI_PRESET_EXPORT_READY, handlePresetExport);
    eventSource.on(event_types.OAI_PRESET_IMPORT_READY, handlePresetImport);
    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, loadGroupsForCurrentPreset);

    // Add a global handler for SillyTavern's own drawer toggles
    $(document).on('click', '.inline-drawer-header', function() {
        const drawer = $(this).closest('.inline-drawer')[0];
        // Short delay to let SillyTavern's own code run first
        setTimeout(() => {
            handleDrawerToggle(drawer);
        }, 50);
    });
});

function handlePresetExport(preset) {
    const currentPreset = oai_settings.preset_settings_openai;
    if (extensionSettings.presets[currentPreset]) {
        preset.linkedToggleGroups = {
            version: extensionSettings.version,
            groups: extensionSettings.presets[currentPreset]
        };
    }
}

function handlePresetImport(importedPreset) {
    if (importedPreset.data.linkedToggleGroups) {
        const importedData = importedPreset.data.linkedToggleGroups;
        extensionSettings.presets[importedPreset.presetName] = importedData.groups;
        debouncedSaveSettings();
        loadGroupsForCurrentPreset();
    }
}

function loadGroupsForCurrentPreset() {
    const currentPreset = oai_settings.preset_settings_openai;
    const groups = extensionSettings.presets[currentPreset] || [];
    loadGroups(groups);
    // No need to call attachGroupEventListeners since we're using delegation
}

async function loadSettings() {
    // Initialize extension_settings[extensionName] with default settings if it doesn't exist
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = Object.assign({}, defaultSettings);
    }

    // Assign extensionSettings for easier access
    extensionSettings = extension_settings[extensionName];

    // Ensure all default settings are present
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!extensionSettings.hasOwnProperty(key)) {
            extensionSettings[key] = value;
        }
    }

    // Load templates only once
    templateCache.drawerTemplate = await $.get(`${extensionFolderPath}/drawer-template.html`);
    templateCache.toggleItemTemplate = await $.get(`${extensionFolderPath}/toggle-item-template.html`);
}

function updateAvailableTargets() {
    const promptManager = setupChatCompletionPromptManager(oai_settings);
    availableTargets = promptManager.serviceSettings.prompts.map(prompt => ({
        value: prompt.identifier,
        text: prompt.name,
        identifier: prompt.identifier
    }));
}

function loadGroups(groups) {
    // Update available targets before rendering
    updateAvailableTargets();
    
    // Clear existing groups using native DOM methods
    if (domCache.toggleGroups) {
        domCache.toggleGroups.innerHTML = '';
    }
    
    // Use DocumentFragment to batch DOM operations
    const fragment = document.createDocumentFragment();
    
    groups.forEach(group => {
        // Create group element from template
        const tempContainer = document.createElement('div');
        tempContainer.innerHTML = templateCache.drawerTemplate.replace('{{GROUP_NAME}}', escapeString(group.name));
        const groupElement = tempContainer.firstElementChild;
        
        // Get toggle list container
        const toggleList = groupElement.querySelector('.toggle-list');
        const toggleAction = groupElement.querySelector('.linked-toggle-group-action');
        
        // Set initial toggle state
        if (group.isOn) {
            toggleAction.classList.remove('fa-toggle-off');
            toggleAction.classList.add('fa-toggle-on');
        } else {
            toggleAction.classList.remove('fa-toggle-on');
            toggleAction.classList.add('fa-toggle-off');
        }
        
        // Add all toggles in batch
        const togglesFragment = document.createDocumentFragment();
        
        group.toggles.forEach(toggle => {
            const tempItemContainer = document.createElement('div');
            tempItemContainer.innerHTML = templateCache.toggleItemTemplate;
            const toggleItem = tempItemContainer.firstElementChild;
            
            // Populate target select in a more efficient way
            const targetSelect = toggleItem.querySelector('.toggle-target');
            populateTargetSelect(targetSelect);
            
            // Set saved values
            targetSelect.value = toggle.target;
            toggleItem.querySelector('.toggle-behavior').value = toggle.behavior;
            
            // Store target as data attribute for faster access
            toggleItem.dataset.target = toggle.target;
            
            togglesFragment.appendChild(toggleItem);
        });
        
        toggleList.appendChild(togglesFragment);
        fragment.appendChild(groupElement);
    });
    
    // Add all groups at once
    domCache.toggleGroups.appendChild(fragment);
    
    // Setup drawer observer after DOM is updated
    setupDrawerObserver();
}

function populateTargetSelect(selectElement) {
    // Create a document fragment to batch option creation
    const fragment = document.createDocumentFragment();
    
    // Add default option
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Select a target';
    defaultOption.disabled = true;
    defaultOption.hidden = true;
    defaultOption.selected = true;
    fragment.appendChild(defaultOption);
    
    // Add all available targets from cache
    availableTargets.forEach(target => {
        const option = document.createElement('option');
        option.value = target.value;
        option.textContent = target.text;
        option.dataset.identifier = target.identifier;
        fragment.appendChild(option);
    });
    
    // Clear existing options and add new ones in a single operation
    selectElement.innerHTML = '';
    selectElement.appendChild(fragment);
}

function setupEventDelegation() {
    // Main click handler for the toggle groups container
    document.addEventListener('click', (e) => {
        // Find the closest relevant elements
        const toggleGroupAction = e.target.closest('.linked-toggle-group-action');
        const groupEdit = e.target.closest('.linked-toggle-group-edit');
        const addToggle = e.target.closest('.add-toggle');
        const groupMoveUp = e.target.closest('.group-move-up');
        const groupMoveDown = e.target.closest('.group-move-down');
        const deleteGroup = e.target.closest('.delete-group');
        const toggleDuplicate = e.target.closest('.linked-toggle-duplicate');
        const toggleDelete = e.target.closest('.linked-toggle-delete');
        const addToggleGroup = e.target.closest('.add-toggle-group');
        
        // Handle each action
        if (toggleGroupAction) {
            e.stopPropagation();
            handleToggleAction(toggleGroupAction);
        } else if (groupEdit) {
            e.stopPropagation();
            handleGroupEdit(groupEdit);
        } else if (addToggle) {
            handleAddToggle(addToggle);
        } else if (groupMoveUp) {
            e.stopPropagation();
            handleGroupMove(groupMoveUp, 'up');
        } else if (groupMoveDown) {
            e.stopPropagation();
            handleGroupMove(groupMoveDown, 'down');
        } else if (deleteGroup) {
            e.stopPropagation();
            handleDeleteGroup(deleteGroup);
        } else if (toggleDuplicate) {
            e.stopImmediatePropagation();
            handleToggleDuplicate(toggleDuplicate);
        } else if (toggleDelete) {
            e.stopImmediatePropagation();
            handleToggleDelete(toggleDelete);
        } else if (addToggleGroup) {
            handleAddGroupClick();
        }

        // Handle drawer toggle clicks
        const drawerToggle = e.target.closest('.inline-drawer-toggle');
        if (drawerToggle) {
            const drawer = drawerToggle.closest('.inline-drawer');
            if (drawer) {
                // Add a small delay to allow for DOM updates
                setTimeout(() => {
                    handleDrawerToggle(drawer);
                }, 10);
            }
        }
    });
    
    // Handle select changes using event delegation
    document.addEventListener('change', (e) => {
        const targetSelect = e.target.closest('.toggle-target');
        const behaviorSelect = e.target.closest('.toggle-behavior');
        const disableAnimationCheckbox = e.target === domCache.disableAnimationCheckbox;
        
        if (targetSelect) {
            const toggleItem = targetSelect.closest('.toggle-item');
            toggleItem.dataset.target = targetSelect.value;
            updateToggleSettings(targetSelect.closest('.toggle-group'));
        } else if (behaviorSelect) {
            updateToggleSettings(behaviorSelect.closest('.toggle-group'));
        } else if (disableAnimationCheckbox) {
            extensionSettings.disableAnimation = domCache.disableAnimationCheckbox.checked;
            debouncedSaveSettings();
        }
    });
}

function handleDrawerToggle(drawer) {
    const content = drawer.querySelector('.inline-drawer-content');
    const isOpen = drawer.classList.contains('open');
    
    if (isOpen) {
        // Calculate proper height when opening
        const contentHeight = calculateContentHeight(content);
        content.style.maxHeight = contentHeight + 'px';
        
        // Make sure toggle items are properly visible
        const toggleItems = drawer.querySelectorAll('.toggle-item');
        toggleItems.forEach(item => {
            item.style.opacity = '1';
        });
    } else {
        // Reset height when closing
        content.style.maxHeight = '0';
    }
}

function calculateContentHeight(content) {
    // Clone the content to measure its full height without constraints
    const clone = content.cloneNode(true);
    
    // Make it invisible but rendered
    clone.style.position = 'absolute';
    clone.style.visibility = 'hidden';
    clone.style.maxHeight = 'none';
    clone.style.height = 'auto';
    
    // Add to DOM temporarily to get measurements
    document.body.appendChild(clone);
    const height = clone.offsetHeight;
    document.body.removeChild(clone);
    
    return height + 20; // Add a bit of extra space
}

// Since SillyTavern might use its own drawer logic, add a mutation observer to catch drawer state changes
function setupDrawerObserver() {
    // Create a mutation observer to watch for class changes
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.type === 'attributes' && 
                mutation.attributeName === 'class' && 
                mutation.target.classList.contains('inline-drawer')) {
                
                handleDrawerToggle(mutation.target);
            }
        });
    });
    
    // Start observing all drawers
    document.querySelectorAll('.toggle-group').forEach(drawer => {
        observer.observe(drawer, { attributes: true });
    });
}

function handleToggleAction(toggleElement) {
    const group = toggleElement.closest('.toggle-group');
    const groupName = group.querySelector('.group-name').textContent;
    
    // Toggle classes using classList methods
    toggleElement.classList.toggle('fa-toggle-off');
    toggleElement.classList.toggle('fa-toggle-on');
    
    const isOn = toggleElement.classList.contains('fa-toggle-on');
    updateGroupState(groupName, isOn);
}

function handleGroupEdit(editElement) {
    const group = editElement.closest('.toggle-group');
    const groupName = group.querySelector('.group-name').textContent;
    editGroupName(group, groupName);
}

function handleAddToggle(addButton) {
    const group = addButton.closest('.toggle-group');
    const groupName = group.querySelector('.group-name').textContent;
    addToggle(group, groupName);
}

function handleGroupMove(moveButton, direction) {
    const group = moveButton.closest('.toggle-group');
    moveGroup(group, direction);
}

function handleDeleteGroup(deleteButton) {
    const group = deleteButton.closest('.toggle-group');
    const groupName = group.querySelector('.group-name').textContent;
    deleteGroup(group, groupName);
}

function handleToggleDuplicate(duplicateButton) {
    const toggleItem = duplicateButton.closest('.toggle-item');
    const group = toggleItem.closest('.toggle-group');
    
    // Create new toggle item more efficiently
    const tempContainer = document.createElement('div');
    tempContainer.innerHTML = templateCache.toggleItemTemplate;
    const newToggleItem = tempContainer.firstElementChild;
    
    // Copy only the behavior
    const behavior = toggleItem.querySelector('.toggle-behavior').value;
    newToggleItem.querySelector('.toggle-behavior').value = behavior;
    
    // Populate the target select
    populateTargetSelect(newToggleItem.querySelector('.toggle-target'));
    
    // Insert after the current toggle item
    toggleItem.after(newToggleItem);
    
    // Update settings
    updateToggleSettings(group);
    
    // Ensure drawer height is recalculated if it's open
    const drawer = group.closest('.inline-drawer');
    if (drawer && drawer.classList.contains('open')) {
        handleDrawerToggle(drawer);
    }
}

function handleToggleDelete(toggleDelete) {
    const toggleItem = toggleDelete.closest('.toggle-item');
    const group = toggleItem.closest('.toggle-group');
    toggleItem.remove();
    updateToggleSettings(group);
}

function addToggle(group, groupName) {
    // Use native DOM methods instead of jQuery
    const toggleList = group.querySelector('.toggle-list');
    
    // Create new toggle item from template
    const tempContainer = document.createElement('div');
    tempContainer.innerHTML = templateCache.toggleItemTemplate;
    const newToggle = tempContainer.firstElementChild;
    
    // Populate the target select
    populateTargetSelect(newToggle.querySelector('.toggle-target'));
    
    // Add to the toggle list
    toggleList.appendChild(newToggle);
    
    // Update the settings
    const currentPreset = oai_settings.preset_settings_openai;
    const groups = extensionSettings.presets[currentPreset];
    const groupObj = groups.find(g => g.name === groupName);
    
    if (groupObj) {
        groupObj.toggles.push({
            target: '',
            behavior: 'direct' // Set default behavior
        });
        debouncedSaveSettings();
        
        // Refresh drawer height if open
        const drawer = group.closest('.inline-drawer');
        if (drawer && drawer.classList.contains('open')) {
            handleDrawerToggle(drawer);
        }
    }
}

function updateToggleSettings(group) {
    // Use efficient querySelector for faster lookups
    const groupName = group.querySelector('.group-name').textContent;
    const currentPreset = oai_settings.preset_settings_openai;
    const groups = extensionSettings.presets[currentPreset];
    const groupObj = groups.find(g => g.name === groupName);
    
    if (groupObj) {
        // Reset toggles array
        groupObj.toggles = [];
        
        // Use querySelectorAll for better performance than jQuery find
        const toggleItems = group.querySelectorAll('.toggle-item');
        
        // Convert NodeList to Array and map to toggle objects
        groupObj.toggles = Array.from(toggleItems).map(item => ({
            target: item.querySelector('.toggle-target').value,
            behavior: item.querySelector('.toggle-behavior').value
        }));
        
        debouncedSaveSettings();
    }
}

function moveGroup(group, direction) {
    // Use native DOM methods for better performance
    const groups = Array.from(document.querySelectorAll('.toggle-group'));
    const index = groups.indexOf(group);
    const currentPreset = oai_settings.preset_settings_openai;
    const presetGroups = extensionSettings.presets[currentPreset];
    
    if (direction === 'up' && index > 0) {
        // Move element in DOM
        group.parentNode.insertBefore(group, groups[index - 1]);
        // Update settings array
        [presetGroups[index], presetGroups[index - 1]] = [presetGroups[index - 1], presetGroups[index]];
    } else if (direction === 'down' && index < groups.length - 1) {
        // Need to insert after the next sibling
        group.parentNode.insertBefore(groups[index + 1], group);
        // Update settings array
        [presetGroups[index], presetGroups[index + 1]] = [presetGroups[index + 1], presetGroups[index]];
    }
    
    debouncedSaveSettings();
}

function updateGroupState(groupName, isOn) {
    const currentPreset = oai_settings.preset_settings_openai;
    if (!extensionSettings.presets[currentPreset]) {
        extensionSettings.presets[currentPreset] = [];
    }
    const groups = extensionSettings.presets[currentPreset];
    const groupIndex = groups.findIndex(g => g.name === groupName);
    
    if (groupIndex !== -1) {
        groups[groupIndex].isOn = isOn;
        debouncedSaveSettings();
        
        // Get all toggles at once for batch processing
        const promptManager = setupChatCompletionPromptManager(oai_settings);
        const toggles = groups[groupIndex].toggles;
        
        // Process all toggles
        toggles.forEach(toggle => {
            applyToggleBehavior(promptManager, toggle, isOn);
        });
        
        // Update UI and save settings only once after processing all toggles
        promptManager.render();
        promptManager.saveServiceSettings();
    }
}

function applyToggleBehavior(promptManager, toggle, isGroupOn) {
    // Cache the prompt order entry to avoid repeated lookups
    const promptOrderEntry = promptManager.getPromptOrderEntry(promptManager.activeCharacter, toggle.target);
    const counts = promptManager.tokenHandler.getCounts();
    
    if (!promptOrderEntry) {
        console.error(`Prompt order entry not found for target: ${toggle.target}`);
        return;
    }
    
    // Apply behavior logic directly without extra operations
    switch (toggle.behavior) {
        case 'direct': promptOrderEntry.enabled = isGroupOn; break;
        case 'invert': promptOrderEntry.enabled = !isGroupOn; break;
        case 'toggle': promptOrderEntry.enabled = !promptOrderEntry.enabled; break;
        case 'random': promptOrderEntry.enabled = Math.random() < 0.5; break;
        default: console.error(`Unknown toggle behavior: ${toggle.behavior}`);
    }
    
    // Reset the token count efficiently
    counts[toggle.target] = null;
    
    // Skip animation completely if disabled
    if (extensionSettings.disableAnimation) return;
    
    // Use native DOM methods for UI updates
    const toggleItem = document.querySelector(`.toggle-item[data-target="${toggle.target}"]`);
    if (!toggleItem) return;
    
    // Apply CSS classes directly
    toggleItem.classList.remove(promptOrderEntry.enabled ? 'disabled' : 'enabled');
    toggleItem.classList.add(promptOrderEntry.enabled ? 'enabled' : 'disabled');
    
    // Use requestAnimationFrame for smoother transitions
    if (toggle.fadeOutTimeout) {
        clearTimeout(toggle.fadeOutTimeout);
    }
    
    // Use CSS transitions instead of jQuery animations
    requestAnimationFrame(() => {
        toggleItem.style.transition = 'background-color 1s, color 1s, opacity 0.3s';
        
        toggle.fadeOutTimeout = setTimeout(() => {
            toggleItem.style.backgroundColor = 'transparent';
            toggleItem.style.color = 'inherit';
            
            if (!promptOrderEntry.enabled) {
                toggleItem.style.opacity = '1.0';
            }
        }, 1000);
    });
}

async function editGroupName(group, currentName) {
    const newName = await callGenericPopup("Enter a name for the new group:", POPUP_TYPE.INPUT, currentName);
    if (newName && newName !== currentName) {
        if (groupNameExists(newName)) {
            toastr.warning(`Group "${newName}" already exists!"`);
            return;
        }
        
        // Update DOM with native methods
        const groupNameElement = group.querySelector('.group-name');
        groupNameElement.textContent = newName;
        
        // Update the group name in the settings
        const currentPreset = oai_settings.preset_settings_openai;
        const groups = extensionSettings.presets[currentPreset];
        const groupIndex = groups.findIndex(g => g.name === currentName);
        if (groupIndex !== -1) {
            groups[groupIndex].name = newName;
            debouncedSaveSettings();
        }
    }
}

function deleteGroup(group, groupName) {
    const currentPreset = oai_settings.preset_settings_openai;
    if (extensionSettings.presets[currentPreset]) {
        extensionSettings.presets[currentPreset] = extensionSettings.presets[currentPreset].filter(g => g.name !== groupName);
        debouncedSaveSettings();
    }
    group.remove();
}

async function handleAddGroupClick() {
    const groupName = await callGenericPopup("Enter a name for the new group:", POPUP_TYPE.INPUT, '');
    if (groupName) {
        if (groupNameExists(groupName)) {
            toastr.warning(`Group "${groupName}" already exists!"`);
            return;
        }
        
        const newGroup = {
            name: groupName,
            toggles: [],
            isOn: false
        };
        
        // Update settings
        const currentPreset = oai_settings.preset_settings_openai;
        extensionSettings.presets[currentPreset] = extensionSettings.presets[currentPreset] || [];
        extensionSettings.presets[currentPreset].push(newGroup);
        
        // Create new group element
        const tempContainer = document.createElement('div');
        tempContainer.innerHTML = templateCache.drawerTemplate.replace('{{GROUP_NAME}}', groupName);
        const groupElement = tempContainer.firstElementChild;
        
        // Add to DOM
        domCache.toggleGroups.appendChild(groupElement);
        
        // Save settings
        debouncedSaveSettings();
    }
}

function groupNameExists(groupName) {
    const currentPreset = oai_settings.preset_settings_openai;
    const groups = extensionSettings.presets[currentPreset] || [];
    const groupNameLower = groupName.toLowerCase();
    
    return groups.some(group => group.name.toLowerCase() === groupNameLower);
}

// Slash command implementation
SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'toggle-group',
    callback: (namedArgs, unnamedArgs) => {
        const searchString = unnamedArgs.toString();
        const targetState = namedArgs.state ?? 'toggle';
        toggleGroupsByString(searchString, targetState);
    },
    aliases: ['tg'],
    namedArgumentList: [
        SlashCommandNamedArgument.fromProps({
            name: 'state',
            description: 'the target state for the group',
            typeList: ARGUMENT_TYPE.STRING,
            defaultValue: 'toggle',
            enumList: ['on', 'off', 'toggle'],
        }),
    ],
    unnamedArgumentList: [
        SlashCommandArgument.fromProps({
            description: 'the string of the group name',
            typeList: ARGUMENT_TYPE.STRING,
            isRequired: true,
        }),
    ],
    helpString: `
        <div>
            Toggles the state of a group named with the provided string.
        </div>
        <div>
            <strong>Example:</strong>
            <ul>
                <li>
                    <pre><code class="language-stscript">/toggle-groups example</code></pre>
                    toggles the state of group named "example"
                </li>
                <li>
                    <pre><code class="language-stscript">/tg state=on test</code></pre>
                    turns on group named "test"
                </li>
                <li>
                    <pre><code class="language-stscript">/tg state=off foo</code></pre>
                    turns off group named "foo"
                </li>
            </ul>
        </div>
    `,
}));

function toggleGroupsByString(searchString, targetState) {
    const currentPreset = oai_settings.preset_settings_openai;
    const groups = extensionSettings.presets[currentPreset] || [];
    const searchStringLower = searchString.toLowerCase();
    let foundGroups = false;
    
    for (const group of groups) {
        if (group.name.toLowerCase() === searchStringLower) {
            foundGroups = true;
            const isOn = targetState === 'toggle' ? !group.isOn : targetState === 'on';
            updateGroupState(group.name, isOn);
            
            // Update UI using native DOM methods
            const groupElement = document.querySelector(`.toggle-group .group-name:contains(${escapeString(group.name)})`).closest('.toggle-group');
            const toggleAction = groupElement.querySelector('.linked-toggle-group-action');
            
            if (isOn) {
                toggleAction.classList.remove('fa-toggle-off');
                toggleAction.classList.add('fa-toggle-on');
            } else {
                toggleAction.classList.remove('fa-toggle-on');
                toggleAction.classList.add('fa-toggle-off');
            }
            break; // Exit the loop early since a match was found
        }
    }
    
    if (!foundGroups) {
        toastr.warning(`No groups found containing "${searchString}".`);
    }
}
