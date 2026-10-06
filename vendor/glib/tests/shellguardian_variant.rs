//! Optimized regression for the upstream RUSTSEC-2024-0429 backport.
use glib::prelude::*;

#[test]
fn string_iterator_reads_forward_and_reverse_out_arguments() {
    let strings = vec!["alpha", "βeta", "guardian", "last"];
    let variant = strings.to_variant();
    assert_eq!(
        variant.array_iter_str().unwrap().collect::<Vec<_>>(),
        strings
    );
    assert_eq!(
        variant.array_iter_str().unwrap().rev().collect::<Vec<_>>(),
        vec!["last", "guardian", "βeta", "alpha"]
    );
}

#[test]
fn string_iterator_supports_mixed_directions_and_exhaustion() {
    let variant = vec!["first", "middle", "last"].to_variant();
    let mut iter = variant.array_iter_str().unwrap();
    assert_eq!(iter.next(), Some("first"));
    assert_eq!(iter.next_back(), Some("last"));
    assert_eq!(iter.next(), Some("middle"));
    assert_eq!(iter.next(), None);
    assert_eq!(iter.next_back(), None);
}
