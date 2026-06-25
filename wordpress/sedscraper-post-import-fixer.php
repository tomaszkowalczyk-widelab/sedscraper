<?php
/**
 * Plugin Name: SEDscraper Post Import Fixer
 * Description: Repairs SEDscraper transcript, sponsors, and Sponsor: Logo fields after WXR import.
 * Version: 1.0.1
 */

if (!defined('ABSPATH')) {
    exit;
}

const SEDSCRAPER_TRANSCRIPT_FIELD_KEY = 'field_6a74sedpodtranscript';
const SEDSCRAPER_SPONSORS_FIELD_KEY = 'field_6a74sedpodsponsors';
const SEDSCRAPER_SPONSOR_LOGO_FIELD_KEY = 'field_6a70sed5logo01';

add_action('admin_menu', function () {
    add_management_page(
        'SEDscraper Import Fixer',
        'SEDscraper Import Fixer',
        'manage_options',
        'sedscraper-import-fixer',
        'sedscraper_render_import_fixer_page'
    );
});

function sedscraper_render_import_fixer_page(): void
{
    if (!current_user_can('manage_options')) {
        wp_die('You do not have permission to run this fixer.');
    }

    $result = null;
    if (isset($_POST['sedscraper_run_fixer'])) {
        check_admin_referer('sedscraper_run_fixer');
        $result = sedscraper_repair_imported_content();
    }
    ?>
    <div class="wrap">
        <h1>SEDscraper Import Fixer</h1>
        <p>Run this after importing the SEDscraper WXR file.</p>
        <?php if (is_array($result)) : ?>
            <div class="notice notice-success">
                <p>
                    Checked <?php echo esc_html((string) $result['podcasts_checked']); ?> podcasts.
                    Transcript fields updated: <?php echo esc_html((string) $result['transcripts_fixed']); ?>.
                    Sponsor relationships updated: <?php echo esc_html((string) $result['sponsors_fixed']); ?>.
                    Sponsor logos updated: <?php echo esc_html((string) $result['sponsor_logos_fixed']); ?>.
                </p>
                <?php if ($result['warnings']) : ?>
                    <ul>
                        <?php foreach ($result['warnings'] as $warning) : ?>
                            <li><?php echo esc_html($warning); ?></li>
                        <?php endforeach; ?>
                    </ul>
                <?php endif; ?>
            </div>
        <?php endif; ?>
        <form method="post">
            <?php wp_nonce_field('sedscraper_run_fixer'); ?>
            <?php submit_button('Run Fixer', 'primary', 'sedscraper_run_fixer'); ?>
        </form>
    </div>
    <?php
}

function sedscraper_repair_imported_content(): array
{
    $result = [
        'podcasts_checked' => 0,
        'transcripts_fixed' => 0,
        'sponsors_fixed' => 0,
        'sponsor_logos_fixed' => 0,
        'warnings' => [],
    ];

    $podcasts = get_posts([
        'post_type' => 'podcast',
        'post_status' => 'any',
        'posts_per_page' => -1,
        'fields' => 'ids',
    ]);

    foreach ($podcasts as $podcast_id) {
        $podcast_id = (int) $podcast_id;
        $result['podcasts_checked']++;

        if (sedscraper_fix_transcript($podcast_id, $result['warnings'])) {
            $result['transcripts_fixed']++;
        }

        if (sedscraper_fix_sponsors($podcast_id, $result['warnings'])) {
            $result['sponsors_fixed']++;
        }
    }

    $result['sponsor_logos_fixed'] = sedscraper_fix_sponsor_logos($result['warnings']);

    return $result;
}

function sedscraper_fix_transcript(int $podcast_id, array &$warnings): bool
{
    $source_url = (string) get_post_meta($podcast_id, '_sed_transcript_source_url', true);
    if ($source_url === '') {
        return false;
    }

    $attachment_id = sedscraper_find_attachment_by_source_url($source_url);
    if (!$attachment_id) {
        $warnings[] = sprintf('Podcast #%d: transcript attachment not found for %s', $podcast_id, $source_url);
        return false;
    }

    update_post_meta($podcast_id, 'transcript_link', (string) $attachment_id);
    update_post_meta($podcast_id, '_transcript_link', SEDSCRAPER_TRANSCRIPT_FIELD_KEY);

    if (function_exists('update_field')) {
        update_field(SEDSCRAPER_TRANSCRIPT_FIELD_KEY, (string) $attachment_id, $podcast_id);
    }

    return true;
}

function sedscraper_fix_sponsors(int $podcast_id, array &$warnings): bool
{
    $raw_keys = (string) get_post_meta($podcast_id, '_sed_sponsor_keys', true);
    if ($raw_keys === '') {
        return false;
    }

    $keys = json_decode($raw_keys, true);
    if (!is_array($keys)) {
        $keys = array_filter(array_map('trim', explode(',', $raw_keys)));
    }

    $sponsor_ids = [];
    foreach ($keys as $key) {
        $sponsor_id = sedscraper_find_sponsor_by_key((string) $key);
        if ($sponsor_id) {
            $sponsor_ids[] = (int) $sponsor_id;
        } else {
            $warnings[] = sprintf('Podcast #%d: sponsor not found for key %s', $podcast_id, (string) $key);
        }
    }

    $sponsor_ids = array_values(array_unique($sponsor_ids));
    if (!$sponsor_ids) {
        return false;
    }

    update_post_meta($podcast_id, 'sponsors', array_map('strval', $sponsor_ids));
    update_post_meta($podcast_id, '_sponsors', SEDSCRAPER_SPONSORS_FIELD_KEY);

    if (function_exists('update_field')) {
        update_field(SEDSCRAPER_SPONSORS_FIELD_KEY, $sponsor_ids, $podcast_id);
    }

    return true;
}

function sedscraper_fix_sponsor_logos(array &$warnings): int
{
    $fixed = 0;
    $sponsor_ids = get_posts([
        'post_type' => 'sponsor',
        'post_status' => 'any',
        'posts_per_page' => -1,
        'fields' => 'ids',
    ]);

    foreach ($sponsor_ids as $sponsor_id) {
        $sponsor_id = (int) $sponsor_id;
        $attachment_id = sedscraper_find_logo_attachment_for_sponsor($sponsor_id);

        if (!$attachment_id) {
            $warnings[] = sprintf('Sponsor #%d: logo attachment not found', $sponsor_id);
            continue;
        }

        update_post_meta($sponsor_id, 'logo', (string) $attachment_id);
        update_post_meta($sponsor_id, '_logo', SEDSCRAPER_SPONSOR_LOGO_FIELD_KEY);

        if (function_exists('update_field')) {
            update_field(SEDSCRAPER_SPONSOR_LOGO_FIELD_KEY, (int) $attachment_id, $sponsor_id);
        }

        $fixed++;
    }

    return $fixed;
}

function sedscraper_find_logo_attachment_for_sponsor(int $sponsor_id): int
{
    $source_url = (string) get_post_meta($sponsor_id, '_sed_sponsor_logo_source_url', true);
    if ($source_url !== '') {
        $attachment_id = sedscraper_find_attachment_by_source_url($source_url);
        if ($attachment_id) {
            return $attachment_id;
        }
    }

    $current_logo = (int) get_post_meta($sponsor_id, 'logo', true);
    if ($current_logo && get_post_type($current_logo) === 'attachment') {
        return $current_logo;
    }

    $children = get_children([
        'post_parent' => $sponsor_id,
        'post_type' => 'attachment',
        'post_mime_type' => 'image',
        'numberposts' => 1,
        'fields' => 'ids',
    ]);

    if ($children) {
        return (int) reset($children);
    }

    $title = get_the_title($sponsor_id);
    if ($title) {
        $ids = get_posts([
            'post_type' => 'attachment',
            'post_status' => 'inherit',
            'post_mime_type' => 'image',
            'posts_per_page' => 1,
            'fields' => 'ids',
            's' => $title,
        ]);

        if (!empty($ids[0])) {
            return (int) $ids[0];
        }
    }

    return 0;
}

function sedscraper_find_attachment_by_source_url(string $source_url): int
{
    $ids = get_posts([
        'post_type' => 'attachment',
        'post_status' => 'inherit',
        'posts_per_page' => 1,
        'fields' => 'ids',
        'meta_key' => '_sed_source_url',
        'meta_value' => $source_url,
    ]);

    if (!empty($ids[0])) {
        return (int) $ids[0];
    }

    $filename = wp_basename((string) (parse_url($source_url, PHP_URL_PATH) ?: $source_url));
    if ($filename === '') {
        return 0;
    }

    $ids = get_posts([
        'post_type' => 'attachment',
        'post_status' => 'inherit',
        'posts_per_page' => 1,
        'fields' => 'ids',
        's' => $filename,
    ]);

    return !empty($ids[0]) ? (int) $ids[0] : 0;
}

function sedscraper_find_sponsor_by_key(string $key): int
{
    $ids = get_posts([
        'post_type' => 'sponsor',
        'post_status' => 'any',
        'posts_per_page' => 1,
        'fields' => 'ids',
        'meta_key' => '_sed_sponsor_key',
        'meta_value' => $key,
    ]);

    return !empty($ids[0]) ? (int) $ids[0] : 0;
}

if (defined('WP_CLI') && WP_CLI) {
    WP_CLI::add_command('sedscraper fix-import', function () {
        $result = sedscraper_repair_imported_content();
        WP_CLI::success(sprintf(
            'Checked %d podcasts. Fixed %d transcript fields, %d sponsor relationships, and %d sponsor logos.',
            $result['podcasts_checked'],
            $result['transcripts_fixed'],
            $result['sponsors_fixed'],
            $result['sponsor_logos_fixed']
        ));
        foreach ($result['warnings'] as $warning) {
            WP_CLI::warning($warning);
        }
    });
}
