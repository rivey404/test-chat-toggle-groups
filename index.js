import { extension_settings } from "../../../extensions.js";
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
};

// Cache for DOM elements
const domCache = {};

// Cache for prompt managers
let promptManagerCache = null;
let lastPreset = null;

// Templates loaded once at startup (kept out of persisted settings)
let drawerTemplate = '';
let toggleItemTemplate = '';

const escapeString = (str) => str.replace(/[&<>"']/g, match => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
})[match]);

// Use a Map for faster group lookups
const groupNameMap = new Map();

const hasOwn = (object, property) => Object.prototype.hasOwnProperty.call(object, property);

function cloneGroups(groups) {
    if (!Array.isArray(groups)) {
        return [];
    }

    return groups
        .filter(group => group && typeof group === 'object')
        .map(group => ({
            ...group,
            toggles: Array.isArray(group.toggles)
                ? group.toggles
                    .filter(toggle => toggle && typeof toggle === 'object')
                    .map(toggle => ({ ...toggle }))
                : [],
        }));
}

function createPresetToggleData(groups, version = extensionSettings.version) {
    return {
        version,
        groups: cloneGroups(groups),
    };
}

function normalizePresetToggleData(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.groups)) {
        return createPresetToggleData([]);
    }

    data.version ??= extensionSettings.version;
    data.groups = cloneGroups(data.groups);
    return data;
}

function getPresetExtensions(preset) {
    if (!preset.extensions || typeof preset.extensions !== 'object' || Array.isArray(preset.extensions)) {
        preset.extensions = {};
    }

    return preset.extensions;
}

function migratePresetToggleData(event) {
    const preset = event?.preset;
    if (!preset || typeof preset !== 'object') {
        return;
    }

    const extensions = getPresetExtensions(preset);

    // An embedded payload, including an empty one, always wins over legacy data.
    if (hasOwn(extensions, extensionName)) {
        extensions[extensionName] = normalizePresetToggleData(extensions[extensionName]);
        return;
    }

    let migratedData;
    if (hasOwn(preset, 'linkedToggleGroups')) {
        migratedData = createPresetToggleData(
            preset.linkedToggleGroups?.groups,
            preset.linkedToggleGroups?.version,
        );
        delete preset.linkedToggleGroups;
    } else if (extensionSettings.presets && hasOwn(extensionSettings.presets, event.presetName)) {
        migratedData = createPresetToggleData(extensionSettings.presets[event.presetName]);
    }

    if (!migratedData) {
        return;
    }

    extensions[extensionName] = migratedData;
    event.savePreset?.(event.presetName, preset, false);
}

function getCurrentPresetToggleData() {
    const extensions = oai_settings.extensions;
    if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) {
        return null;
    }

    const data = extensions[extensionName];
    return data && typeof data === 'object' && Array.isArray(data.groups) ? data : null;
}

function getCurrentPresetGroups() {
    return getCurrentPresetToggleData()?.groups || [];
}

function migrateCurrentPresetToggleData() {
    const currentPreset = oai_settings.preset_settings_openai;
    if (!currentPreset || getCurrentPresetToggleData() || !extensionSettings.presets?.[currentPreset]) {
        return;
    }

    oai_settings.extensions ??= {};
    oai_settings.extensions[extensionName] = createPresetToggleData(extensionSettings.presets[currentPreset]);
}

function getOrCreateCurrentPresetToggleData() {
    if (!oai_settings.extensions || typeof oai_settings.extensions !== 'object' || Array.isArray(oai_settings.extensions)) {
        oai_settings.extensions = {};
    }

    if (!oai_settings.extensions[extensionName] || typeof oai_settings.extensions[extensionName] !== 'object') {
        oai_settings.extensions[extensionName] = createPresetToggleData([]);
    } else if (!Array.isArray(oai_settings.extensions[extensionName].groups)) {
        oai_settings.extensions[extensionName].groups = [];
    }

    oai_settings.extensions[extensionName].version ??= extensionSettings.version;

    return oai_settings.extensions[extensionName];
}

// saveSettingsDebounced is already debounced by SillyTavern — call it directly.
function debouncedSaveSettings() {
    extension_settings[extensionName] = extensionSettings;
    saveSettingsDebounced();
}

jQuery(async () => {
    await loadSettings();
    const toggleMenu = await $.get(`${extensionFolderPath}/toggle-menu.html`);
    $('.range-block.m-b-1').before(toggleMenu);
    
    // Cache frequently accessed DOM elements
    domCache.$toggleGroups = $('.toggle-groups');

    // Load groups for the current preset
    migrateCurrentPresetToggleData();
    loadGroupsForCurrentPreset();

    // Attach event listeners once using event delegation
    attachEventListeners();

    // Event listeners for preset changes and exports/imports
    setupEventListeners();
});

function setupEventListeners() {
    // Add toggle group button
    $(".add-toggle-group").on("click", onAddGroupClick);

    // Migrate legacy data before SillyTavern applies the incoming preset.
    eventSource.on(event_types.OAI_PRESET_CHANGED_BEFORE, migratePresetToggleData);

    // Reload the UI after SillyTavern has applied the incoming preset.
    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, () => {
        loadGroupsForCurrentPreset();
    });

    // Convert exports from older versions when they are imported. New exports
    // already contain the data in the native preset extensions object.
    eventSource.on(event_types.OAI_PRESET_IMPORT_READY, (importedPreset) => {
        const preset = importedPreset?.data;
        if (!preset || typeof preset !== 'object') {
            return;
        }

        const extensions = getPresetExtensions(preset);
        if (!hasOwn(extensions, extensionName) && hasOwn(preset, 'linkedToggleGroups')) {
            extensions[extensionName] = createPresetToggleData(
                preset.linkedToggleGroups?.groups,
                preset.linkedToggleGroups?.version,
            );
            delete preset.linkedToggleGroups;
        }
    });
}

function buildGroupNameMap() {
    groupNameMap.clear();
    const groups = getCurrentPresetGroups();
    
    groups.forEach((group, index) => {
        if (typeof group.name === 'string') {
            groupNameMap.set(group.name.toLowerCase(), { group, index });
        }
    });
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

    if (!extensionSettings.presets || typeof extensionSettings.presets !== 'object') {
        extensionSettings.presets = {};
    }

    // Load templates just once and cache them in module scope (not in settings,
    // so they don't get written to settings.json on every save)
    [drawerTemplate, toggleItemTemplate] = await Promise.all([
        $.get(`${extensionFolderPath}/drawer-template.html`),
        $.get(`${extensionFolderPath}/toggle-item-template.html`)
    ]);
}

function getPromptManager() {
    // Cache the prompt manager to avoid repeated creation
    const currentPreset = oai_settings.preset_settings_openai;
    if (!promptManagerCache || lastPreset !== currentPreset) {
        promptManagerCache = setupChatCompletionPromptManager(oai_settings);
        lastPreset = currentPreset;
    }
    return promptManagerCache;
}

function loadGroupsForCurrentPreset() {
    const groups = getCurrentPresetGroups();
    
    // Rebuild the group name map for quick lookups
    buildGroupNameMap();
    
    // Load the groups into the UI
    loadGroups(groups);
}

function loadGroups(groups) {
    if (!domCache.$toggleGroups) {
        domCache.$toggleGroups = $('.toggle-groups');
    }
    
    domCache.$toggleGroups.empty(); // Clear existing groups

    // Create a document fragment for better performance
    const fragment = document.createDocumentFragment();
    const promptManager = getPromptManager();

    // Prepare options once for all groups (cached — see prepareTargetOptions)
    const targetOptions = prepareTargetOptions(promptManager);

    groups.forEach(group => {
        const $groupElement = $(drawerTemplate.replace('{{GROUP_NAME}}', escapeString(group.name)));
        const $toggleList = $groupElement.find('.toggle-list');
        const $toggleAction = $groupElement.find('.linked-toggle-group-action');

        // Set initial toggle state
        if (group.isOn) {
            $toggleAction.removeClass('fa-toggle-off').addClass('fa-toggle-on');
        } else {
            $toggleAction.removeClass('fa-toggle-on').addClass('fa-toggle-off');
        }

        // Create all toggle items at once
        const toggleItemsFragment = document.createDocumentFragment();

        const toggles = Array.isArray(group.toggles) ? group.toggles : [];
        toggles.forEach(toggle => {
            const $toggleItem = $(toggleItemTemplate);
            const $target = $toggleItem.find('.toggle-target');
            
            // Populate target select efficiently
            $target.html(targetOptions);
            $target.val(toggle.target);
            
            $toggleItem.find('.toggle-behavior').val(toggle.behavior);
            $toggleItem.attr('data-target', toggle.target);
            
            toggleItemsFragment.appendChild($toggleItem[0]);
        });

        $toggleList.append(toggleItemsFragment);
        fragment.appendChild($groupElement[0]);
    });

    domCache.$toggleGroups.append(fragment);
}

// Cache the options HTML — rebuilding means re-sorting the whole prompt list,
// so only do it when the prompts array actually changes.
let cachedOptionsPrompts = null;
let cachedOptionsHtml = null;

// Prepare options HTML once to avoid repetitive DOM creation
function prepareTargetOptions(promptManager) {
    const prompts = promptManager.serviceSettings.prompts;

    if (prompts === cachedOptionsPrompts && cachedOptionsHtml !== null) {
        return cachedOptionsHtml;
    }

    // Sort prompts alphabetically by name
    const sortedPrompts = [...prompts].sort((a, b) => a.name.localeCompare(b.name));

    let optionsHtml = '<option value="" disabled hidden selected>Select a target</option>';

    sortedPrompts.forEach(prompt => {
        optionsHtml += `<option value="${prompt.identifier}" data-identifier="${prompt.identifier}">${escapeString(prompt.name)}</option>`;
    });

    cachedOptionsPrompts = prompts;
    cachedOptionsHtml = optionsHtml;

    return optionsHtml;
}

function attachEventListeners() {
    // Use event delegation for most events to improve performance
    const $body = $('body');
    
    // Group toggle actions
    $body.on("click", ".linked-toggle-group-action", function(e) {
        e.stopPropagation();
        const $toggle = $(this);
        const $group = $toggle.closest('.toggle-group');
        const groupName = $group.find('.group-name').text();

        $toggle.toggleClass('fa-toggle-off fa-toggle-on');

        const isOn = $toggle.hasClass('fa-toggle-on');
        updateGroupState(groupName, isOn);
    });

    // Group name editing
    $body.on("click", ".linked-toggle-group-edit", function(e) {
        e.stopPropagation();
        const $group = $(this).closest('.toggle-group');
        const groupName = $group.find('.group-name').text();
        editGroupName($group, groupName);
    });

    // Add toggle to group
    $body.on("click", ".add-toggle", function() {
        const $group = $(this).closest('.toggle-group');
        const groupName = $group.find('.group-name').text();
        addToggle($group, groupName);
    });

    // Group movement
    $body.on("click", ".group-move-up, .group-move-down", function(e) {
        e.stopPropagation();
        const $group = $(this).closest('.toggle-group');
        const direction = $(this).hasClass('group-move-up') ? 'up' : 'down';
        moveGroup($group, direction);
    });

    // Delete group
    $body.on("click", ".delete-group", function(e) {
        e.stopPropagation();
        const $group = $(this).closest('.toggle-group');
        const groupName = $group.find('.group-name').text();
        deleteGroup($group, groupName);
    });

    // Toggle item actions
    $body.on("click", ".linked-toggle-duplicate", function(e) {
        e.stopImmediatePropagation();
        duplicateToggleItem($(this));
    });

    $body.on("click", ".linked-toggle-delete", function(e) {
        e.stopImmediatePropagation();
        const $toggleItem = $(this).closest('.toggle-item');
        const $group = $toggleItem.closest('.toggle-group');
        $toggleItem.remove();
        // Update settings
        updateToggleSettings($group);
    });

    // Toggle target/behavior changes
    $body.on("change", ".toggle-target, .toggle-behavior", function() {
        const $group = $(this).closest('.toggle-group');
        updateToggleSettings($group);
    });

    $body.on("change", ".toggle-target", function() {
        const $toggleItem = $(this).closest('.toggle-item');
        const newTarget = $(this).val();
        $toggleItem.attr('data-target', newTarget);
    });
}

function duplicateToggleItem($button) {
    const $toggleItem = $button.closest('.toggle-item');
    const $group = $toggleItem.closest('.toggle-group');
    const $newToggleItem = $(toggleItemTemplate);

    // Copy behavior and target from the source row
    const behavior = $toggleItem.find('.toggle-behavior').val();
    const target = $toggleItem.find('.toggle-target').val();
    $newToggleItem.find('.toggle-behavior').val(behavior);

    // Get prompt manager once
    const promptManager = getPromptManager();

    // Reuse target options
    const targetOptions = prepareTargetOptions(promptManager);
    $newToggleItem.find('.toggle-target').html(targetOptions);
    if (target) {
        $newToggleItem.find('.toggle-target').val(target);
        $newToggleItem.attr('data-target', target);
    }

    $toggleItem.after($newToggleItem);

    // Update settings
    updateToggleSettings($group);
}

function addToggle($group, groupName) {
    const $toggleList = $group.find('.toggle-list');
    const $newToggle = $(toggleItemTemplate);
    
    // Get prompt manager once and reuse
    const promptManager = getPromptManager();
    
    // Efficiently populate the target select with prepared options
    $newToggle.find('.toggle-target').html(prepareTargetOptions(promptManager));
    
    $toggleList.append($newToggle);

    // Update the settings
    updateToggleSettings($group);
}

function updateToggleSettings($group) {
    const groupName = $group.find('.group-name').text();
    const groupData = groupNameMap.get(groupName.toLowerCase());
    
    if (groupData) {
        const { group } = groupData;
        group.toggles = [];

        $group.find('.toggle-item').each(function() {
            const $item = $(this);
            group.toggles.push({
                target: $item.find('.toggle-target').val(),
                behavior: $item.find('.toggle-behavior').val()
            });
        });

        debouncedSaveSettings();
    }
}

function moveGroup($group, direction) {
    const groupName = $group.find('.group-name').first().text();
    const groupData = groupNameMap.get(groupName.toLowerCase());

    if (!groupData) {
        return;
    }

    const groups = getCurrentPresetGroups();
    const index = groupData.index;

    if (direction === 'up' && index > 0) {
        $group.insertBefore($group.prev('.toggle-group'));
        [groups[index], groups[index - 1]] = [groups[index - 1], groups[index]];
    } else if (direction === 'down' && index < groups.length - 1) {
        $group.insertAfter($group.next('.toggle-group'));
        [groups[index], groups[index + 1]] = [groups[index + 1], groups[index]];
    } else {
        return; // No move happened — skip the map rebuild and save
    }

    // Rebuild group name map after reordering
    buildGroupNameMap();
    debouncedSaveSettings();
}

function updateGroupState(groupName, isOn) {
    const groupData = groupNameMap.get(groupName.toLowerCase());
    
    if (groupData) {
        const { group } = groupData;
        group.isOn = isOn;

        // Get prompt manager once for all toggle operations
        const promptManager = getPromptManager();
        const counts = promptManager.tokenHandler.getCounts();

        // Process all toggles efficiently
        group.toggles.forEach(toggle => {
            const promptOrderEntry = promptManager.getPromptOrderEntry(promptManager.activeCharacter, toggle.target);
            
            if (!promptOrderEntry) {
                console.error(`Prompt order entry not found for target: ${toggle.target}`);
                return;
            }

            switch (toggle.behavior) {
                case 'direct':
                    promptOrderEntry.enabled = isOn;
                    break;
                case 'invert':
                    promptOrderEntry.enabled = !isOn;
                    break;
                case 'toggle':
                    promptOrderEntry.enabled = !promptOrderEntry.enabled;
                    break;
                case 'random':
                    promptOrderEntry.enabled = Math.random() < 0.5;
                    break;
            }

            // Reset the token count for the affected prompt
            counts[toggle.target] = null;
        });

        // Update UI and save only once after all changes are processed
        promptManager.render();
        promptManager.saveServiceSettings();
        debouncedSaveSettings();
    } else {
        console.error(`Group "${groupName}" not found in the current preset.`);
    }
}

async function editGroupName($group, currentName) {
    const newName = await callGenericPopup("Enter a name for the new group:", POPUP_TYPE.INPUT, currentName);
    if (newName && newName !== currentName) {
        const groupData = groupNameMap.get(currentName.toLowerCase());
        const existing = groupNameMap.get(newName.toLowerCase());

        // Block collisions with *other* groups, but allow case-only renames
        if (existing && existing !== groupData) {
            toastr.warning(`Group "${newName}" already exists!`);
            return;
        }

        const $groupName = $group.find('.group-name');
        $groupName.text(newName);

        // Update the group name in the settings using the Map
        if (groupData) {
            const { group } = groupData;
            group.name = newName;

            // Update map with new name
            groupNameMap.delete(currentName.toLowerCase());
            groupNameMap.set(newName.toLowerCase(), groupData);

            debouncedSaveSettings();
        }
    }
}

function deleteGroup($group, groupName) {
    const lowerName = groupName.toLowerCase();
    const groups = getCurrentPresetGroups();
    if (groupNameMap.has(lowerName)) {
        const { index } = groupNameMap.get(lowerName);
        groups.splice(index, 1);
        groupNameMap.delete(lowerName);

        // Rebuild map to update indices
        buildGroupNameMap();

        debouncedSaveSettings();
    }
    $group.remove();
}

async function onAddGroupClick() {
    const groupName = await callGenericPopup("Enter a name for the new group:", POPUP_TYPE.INPUT, '');
    if (groupName) {
        // Use Map for faster lookup
        if (groupNameMap.has(groupName.toLowerCase())) {
            toastr.warning(`Group "${groupName}" already exists!`);
            return;
        }
        
        const newGroup = {
            name: groupName,
            toggles: [],
            isOn: false
        };

        const groups = getOrCreateCurrentPresetToggleData().groups;
        const newIndex = groups.length;
        groups.push(newGroup);
        
        // Update map with new group
        groupNameMap.set(groupName.toLowerCase(), { group: newGroup, index: newIndex });

        const $groupElement = $(drawerTemplate.replace('{{GROUP_NAME}}', groupName));
        domCache.$toggleGroups.append($groupElement);

        // Save the updated settings
        debouncedSaveSettings();
    }
}

function toggleGroupsByString(searchString, targetState) {
    // Use Map for O(1) lookup
    const lowerSearchString = searchString.toLowerCase();
    const groupData = groupNameMap.get(lowerSearchString);
    
    if (groupData) {
        const { group } = groupData;
        const isOn = targetState === 'toggle' ? !group.isOn : targetState === 'on';
        updateGroupState(group.name, isOn);

        // Exact-match lookup scoped to the toggle-groups container — no selector
        // injection and no substring false positives.
        const $group = domCache.$toggleGroups.find('.toggle-group').filter(function() {
            return $(this).find('.group-name').first().text() === group.name;
        });
        const $toggleAction = $group.find('.linked-toggle-group-action');

        if (isOn) {
            $toggleAction.removeClass('fa-toggle-off').addClass('fa-toggle-on');
        } else {
            $toggleAction.removeClass('fa-toggle-on').addClass('fa-toggle-off');
        }
    } else {
        toastr.warning(`No group named "${searchString}" found.`);
    }
}

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
