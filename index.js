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
    disableAnimation: true, // Default animation to disabled for better performance
    saveDebounceMs: 1000, // Add debounce control setting
};

// Cache for DOM elements
const domCache = {};

// Cache for prompt managers
let promptManagerCache = null;
let lastPreset = null;

const escapeString = (str) => str.replace(/[&<>"']/g, match => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
})[match]);

// Use a Map for faster group lookups
const groupNameMap = new Map();

// Debounce the settings save with a longer delay
const debouncedSaveSettings = (() => {
    let timer = null;
    return () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            extension_settings[extensionName] = extensionSettings;
            saveSettingsDebounced();
        }, extensionSettings.saveDebounceMs || 1000);
    };
})();

jQuery(async () => {
    await loadSettings();
    const toggleMenu = await $.get(`${extensionFolderPath}/toggle-menu.html`);
    $('.range-block.m-b-1').before(toggleMenu);
    
    // Cache frequently accessed DOM elements
    domCache.$toggleGroups = $('.toggle-groups');
    domCache.$disableAnimationCheckbox = $('#disable-animation-checkbox');
    
    // Load groups for the current preset
    loadGroupsForCurrentPreset();
    
    // Attach event listeners once using event delegation
    attachEventListeners();
    
    // Initialize the "Disable Animation" checkbox
    domCache.$disableAnimationCheckbox.prop('checked', extensionSettings.disableAnimation);

    // Event listeners for preset changes and exports/imports
    setupEventListeners();
});

function setupEventListeners() {
    // Add toggle group button
    $(".add-toggle-group").on("click", onAddGroupClick);
    
    // Disable animation checkbox
    domCache.$disableAnimationCheckbox.on('change', () => {
        extensionSettings.disableAnimation = domCache.$disableAnimationCheckbox.is(':checked');
        debouncedSaveSettings();
    });
    
    // Preset change event
    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, () => {
        loadGroupsForCurrentPreset();
    });
    
    // Export/Import events
    eventSource.on(event_types.OAI_PRESET_EXPORT_READY, (preset) => {
        const currentPreset = oai_settings.preset_settings_openai;

        // Check if there's data for the current preset
        if (extensionSettings.presets[currentPreset]) {
            // Add the linked toggle groups data and version to the preset
            preset.linkedToggleGroups = {
                version: extensionSettings.version,
                groups: extensionSettings.presets[currentPreset]
            };
        }
    });

    eventSource.on(event_types.OAI_PRESET_IMPORT_READY, (importedPreset) => {
        if (importedPreset.data.linkedToggleGroups) {
            const importedData = importedPreset.data.linkedToggleGroups;
            
            // Update the extension settings with the imported data
            extensionSettings.presets[importedPreset.presetName] = importedData.groups;
            
            // Rebuild group name map
            buildGroupNameMap();
            
            // Save the updated settings
            debouncedSaveSettings();
            
            // Reload the groups for the current preset
            loadGroupsForCurrentPreset();
        }
    });
}

function buildGroupNameMap() {
    groupNameMap.clear();
    const currentPreset = oai_settings.preset_settings_openai;
    const groups = extensionSettings.presets[currentPreset] || [];
    
    groups.forEach((group, index) => {
        groupNameMap.set(group.name.toLowerCase(), { group, index });
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

    // Load templates just once and cache them
    const [drawerTemplate, toggleItemTemplate] = await Promise.all([
        $.get(`${extensionFolderPath}/drawer-template.html`),
        $.get(`${extensionFolderPath}/toggle-item-template.html`)
    ]);
    
    // Store the templates in the extension settings for later use
    extensionSettings.drawerTemplate = drawerTemplate;
    extensionSettings.toggleItemTemplate = toggleItemTemplate;
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
    const currentPreset = oai_settings.preset_settings_openai;
    const groups = extensionSettings.presets[currentPreset] || [];
    
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

    groups.forEach(group => {
        const $groupElement = $(extensionSettings.drawerTemplate.replace('{{GROUP_NAME}}', escapeString(group.name)));
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
        
        // Prepare all options once
        const targetOptions = prepareTargetOptions(promptManager);
        
        group.toggles.forEach(toggle => {
            const $toggleItem = $(extensionSettings.toggleItemTemplate);
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

// Prepare options HTML once to avoid repetitive DOM creation
function prepareTargetOptions(promptManager) {
    const prompts = promptManager.serviceSettings.prompts;
    let optionsHtml = '<option value="" disabled hidden selected>Select a target</option>';
    
    prompts.forEach(prompt => {
        optionsHtml += `<option value="${prompt.identifier}" data-identifier="${prompt.identifier}">${escapeString(prompt.name)}</option>`;
    });
    
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
    const $newToggleItem = $(extensionSettings.toggleItemTemplate);
    
    // Copy behavior
    const behavior = $toggleItem.find('.toggle-behavior').val();
    $newToggleItem.find('.toggle-behavior').val(behavior);
    
    // Get prompt manager once
    const promptManager = getPromptManager();
    
    // Reuse target options
    const targetOptions = prepareTargetOptions(promptManager);
    $newToggleItem.find('.toggle-target').html(targetOptions);
    
    $toggleItem.after($newToggleItem);
    
    // Update settings
    updateToggleSettings($group);
}

function addToggle($group, groupName) {
    const $toggleList = $group.find('.toggle-list');
    const $newToggle = $(extensionSettings.toggleItemTemplate);
    
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
    const $groups = $('.toggle-group');
    const index = $groups.index($group);
    const currentPreset = oai_settings.preset_settings_openai;
    const groups = extensionSettings.presets[currentPreset];

    if (direction === 'up' && index > 0) {
        $group.insertBefore($groups.eq(index - 1));
        [groups[index], groups[index - 1]] = [groups[index - 1], groups[index]];
    } else if (direction === 'down' && index < $groups.length - 1) {
        $group.insertAfter($groups.eq(index + 1));
        [groups[index], groups[index + 1]] = [groups[index + 1], groups[index]];
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
        debouncedSaveSettings();

        // Get prompt manager once for all toggle operations
        const promptManager = getPromptManager();
        const counts = promptManager.tokenHandler.getCounts();
        const affectedPrompts = new Set();
        
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
            affectedPrompts.add(toggle.target);
            
            // Skip animation if disabled
            if (extensionSettings.disableAnimation) {
                return;
            }

            // Apply visual feedback with minimal DOM operations
            const $toggleItem = $(`.toggle-item[data-target="${toggle.target}"]`);
            
            if (promptOrderEntry.enabled) {
                $toggleItem.addClass('enabled').removeClass('disabled');
            } else {
                $toggleItem.addClass('disabled').removeClass('enabled');
            }

            // Use data attribute to track timeout IDs
            const timeoutId = $toggleItem.data('fade-timeout');
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            
            const newTimeoutId = setTimeout(() => {
                $toggleItem.css({
                    'background-color': 'transparent',
                    'color': 'transparent'
                });

                if (!promptOrderEntry.enabled) {
                    $toggleItem.animate({ opacity: 1.0 }, 300);
                }
                
                $toggleItem.removeData('fade-timeout');
            }, 1000);
            
            $toggleItem.data('fade-timeout', newTimeoutId);
        });

        // Update UI and save only once after all changes are processed
        promptManager.render();
        promptManager.saveServiceSettings();
    } else {
        console.error(`Group "${groupName}" not found in the current preset.`);
    }
}

async function editGroupName($group, currentName) {
    const newName = await callGenericPopup("Enter a name for the new group:", POPUP_TYPE.INPUT, currentName);
    if (newName && newName !== currentName) {
        // Use Map for faster lookup
        if (groupNameMap.has(newName.toLowerCase())) {
            toastr.warning(`Group "${newName}" already exists!`);
            return;
        }
        
        const $groupName = $group.find('.group-name');
        $groupName.text(newName);

        // Update the group name in the settings using the Map
        const groupData = groupNameMap.get(currentName.toLowerCase());
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
    const currentPreset = oai_settings.preset_settings_openai;
    if (extensionSettings.presets[currentPreset]) {
        // Use Map for faster deletion
        const lowerName = groupName.toLowerCase();
        if (groupNameMap.has(lowerName)) {
            const { index } = groupNameMap.get(lowerName);
            extensionSettings.presets[currentPreset].splice(index, 1);
            groupNameMap.delete(lowerName);
            
            // Rebuild map to update indices
            buildGroupNameMap();
            debouncedSaveSettings();
        }
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

        const currentPreset = oai_settings.preset_settings_openai;
        extensionSettings.presets[currentPreset] = extensionSettings.presets[currentPreset] || [];
        const newIndex = extensionSettings.presets[currentPreset].length;
        extensionSettings.presets[currentPreset].push(newGroup);
        
        // Update map with new group
        groupNameMap.set(groupName.toLowerCase(), { group: newGroup, index: newIndex });

        const $groupElement = $(extensionSettings.drawerTemplate.replace('{{GROUP_NAME}}', groupName));
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

        const $group = $(`.toggle-group .group-name:contains(${escapeString(group.name)})`).closest('.toggle-group');
        const $toggleAction = $group.find('.linked-toggle-group-action');

        if (isOn) {
            $toggleAction.removeClass('fa-toggle-off').addClass('fa-toggle-on');
        } else {
            $toggleAction.removeClass('fa-toggle-on').addClass('fa-toggle-off');
        }
    } else {
        toastr.warning(`No groups found containing "${searchString}".`);
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
